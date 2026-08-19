// application-foundation.mts — CQ-1 foundation module.
// Owns immutable configuration, generic UI chrome (Toast/Modal), the perf
// profiler, and the virtual-list windowing helper. No schedule state, no
// feature endpoints, no scheduling rules. See docs/architecture/
// cq1-compatibility-inventory.md for the full module ownership map.

import type { NimbusTask } from './types.mjs';

// Ambient augmentation: these three custom globals are read via
// `window.NIMBUS_API_BASE`/`window.NIMBUS_BUILD_ID`/`window.__NIMBUS_LOCALES`
// below and nowhere else in the codebase declares them yet.
declare global {
  interface Window {
    NIMBUS_API_BASE?: string;
    NIMBUS_BUILD_ID?: string;
    __NIMBUS_LOCALES?: Record<string, Record<string, string>>;
  }
}

// -- Local type declarations (Phase 1 conversion; scoped to this file) ------
type PreferenceResolver = (key: string) => string | undefined;
type ActorResolver = () => string | undefined;

// The full per-line/day utilization matrix type is Phase 3's domain
// (schedule-services.mts, not yet converted). This resolver only ever reads
// `.pct` off a matrix cell (see Util.scheduleKpis below), so it's typed to
// exactly that shape rather than importing a type that doesn't exist yet.
type UtilizationResolverFn = (
  date: Date, days: number, tasks: NimbusTask[], context?: unknown
) => Record<string, Record<string, { pct?: number } | undefined>>;

interface VirtualListOptions<T> {
  rowH?: number;
  getRowH?: (item: T) => number;
  renderFn: (item: T, index: number) => string;
  mountEl?: HTMLElement;
  buffer?: number;
}

interface PerfBucket {
  buf: Float32Array;
  head: number;
  count: number;
  last: number;
  lastTs: number;
}

interface PerfStats {
  last: number;
  lastTs: number;
  count: number;
  p50: number;
  p95: number;
  max: number;
}

type LogLevel = 'info' | 'warn' | 'error';

interface LogOpts {
  reqId?: string;
  errorCode?: string;
  stack?: string;
}

interface LogEntry {
  ts: string;
  level: LogLevel;
  scope: string;
  msg: string;
  ctx: unknown;
  reqId?: string;
  errorCode?: string;
  stack?: string;
  buildId: string;
  sessionId: string;
  plant?: string;
  route?: string;
}

interface Breadcrumb {
  t: number;
  type: string;
  d?: unknown;
}

interface RecentEntry {
  ts: number;
  level: LogLevel;
}

interface ToastEntry {
  el: HTMLDivElement;
  msg: string;
  type: string;
  timerId: ReturnType<typeof setTimeout> | null;
  _removing: boolean;
}

interface ModalConfirmOpts {
  title?: string;
  message?: string;
  detail?: string;
  confirmLabel?: string;
  tone?: 'danger' | 'warn';
}

type PasteWiredInput = HTMLInputElement & { _pasteWired?: boolean };

/* =============================================================================
   CONFIG — global constants; never mutated at runtime.
     STEP_MS          15-minute snap granularity for all drag/edit ops
     DEFAULT_SHIFT    [startHour, endHour] used when no plant calendar exists
     COLORS           10-color palette for production lines
     OVERLOAD/WARN    thresholds for the utilisation alert system
     LS_KEY           localStorage key for the v3 state cache
     SCHEMA_VERSION   bump this when the cached snapshot shape changes
     KNOWN_PLANTS     plant codes the app is aware of (for plant selector)
   ========================================================================== */
export const Config = {
  API_BASE:         (typeof window !== 'undefined' && window.NIMBUS_API_BASE) || '',  // '' = same-origin (relative URLs); set window.NIMBUS_API_BASE only for a split dev server
  STEP_MS:          15 * 60 * 1000,          // 15-minute snap
  MS_MIN:           60 * 1000,               // 1 minute in ms
  MS_HOUR:          60 * 60 * 1000,          // 1 hour in ms
  MS_DAY:           24 * 60 * 60 * 1000,     // 1 day in ms
  ANIM_MS:          220,                     // CSS-coupled: must outlast .side-right / .alert-drawer transition 0.22s
  DEFAULT_SHIFT:    [7, 19],                  // 7:00 → 19:00 (12h shift)
  WEEKEND_OFF:      true,                     // Sat/Sun closed by default
  TZ:               'America/New_York',
  COLORS: [                                   // production-line palette (10)
    '#b8791a', '#2d5f8c', '#4f7a3c', '#8b4c7e', '#b14a3e',
    '#3c6e7a', '#7a5a2a', '#5e498b', '#a8493a', '#4a7a5e'
  ],
  OVERLOAD_THRESHOLD: 1.0,                    // >100% → error, >80% → warn
  WARN_THRESHOLD:     0.8,
  SHOW_NEAR_CAPACITY_ALERTS: false,           // set true to re-enable near-capacity warnings
  LS_KEY:             'nimbus.state.v3',          // do NOT bump for shape changes — use SCHEMA_VERSION
  SCHEMA_VERSION:     6,                          // bump whenever _saveCache snapshot fields change
  BUILD_ID:           (typeof window !== 'undefined' && window.NIMBUS_BUILD_ID) || 'dev',
  DEFAULT_PLANT:      null,
  KNOWN_PLANTS:       ['5512', '1006'],
  CENTER_ON_CLICK:    true,                       // set false to disable click-to-center in Gantt
  DEBUG_BLOCKS:       true,                       // when true, Store.addBlock/addPlantBlock console.trace every push (for diagnosing duplicate-add bugs)
  CONCURRENCY_CHECK:  true,                        // optimistic-concurrency guard on task writes. Set false to force every write (legacy last-write-wins) if the guard misbehaves in a multi-user pilot.
  SESSION_MAX_AGE_MS: 12 * 60 * 60 * 1000          // local login cache lifetime (Session.isExpired) — 12h literal, not 12 * Config.MS_HOUR (Config can't reference itself mid-initializer)
};

/* =============================================================================
   UTIL — small pure helpers (no state, no DOM)

   Four DI seams replace what used to be direct references from Util into
   modules that stay in app.js (Store, Session, Utilization, Engine) — each
   defaults to a safe no-op/fallback matching the original
   try/catch-swallowed behavior:
     setPreferenceResolver(fn)   — feeds _timeFormatPref/_dateFormatPref (was Store.pref)
     setActorResolver(fn)        — feeds fetchTraced's x-user-email header (was Session.actor)
     setUtilizationResolver(fn)  — feeds scheduleKpis' peak-util lookup (was Utilization.computeMatrix)
     setChangeoverFieldsResolver(fn) — feeds countChangeovers' field set
                                   (Engine.changeoverTaskFields, which Util may
                                   not import: Engine is the Domain layer)
   locale()/setLocale() replace the old `Util._locale` property so the active
   locale is proper module state instead of a bag property.
   ========================================================================== */
let _prefResolver: PreferenceResolver = () => undefined;
let _actorResolver: ActorResolver = () => undefined;
let _utilizationResolver: UtilizationResolverFn | null = null;
let _changeoverFieldsResolver: (() => string[]) | null = null;
let _locale: string = (typeof localStorage !== 'undefined' && localStorage.getItem('nimbus.locale')) || 'en';

/** What counts as a changeover when no resolver is wired (Node tests, or before
 *  app.js's boot glue runs): the historical hardcoded pair, so an unwired Util
 *  behaves exactly as it did before this seam existed. */
// Frozen because changeoverFields() hands this exact array out to public callers
// (the alert cell-briefing reads it), and one stray push would corrupt the
// fallback for the rest of the session.
const _DEFAULT_CHANGEOVER_FIELDS: readonly string[] = Object.freeze(['COLOR', 'FORM_SIZE']);

export const Util = {
  setPreferenceResolver(fn: PreferenceResolver): void { _prefResolver = typeof fn === 'function' ? fn : () => undefined; },
  setActorResolver(fn: ActorResolver): void { _actorResolver = typeof fn === 'function' ? fn : () => undefined; },
  setUtilizationResolver(fn: UtilizationResolverFn | null): void { _utilizationResolver = typeof fn === 'function' ? fn : null; },
  setChangeoverFieldsResolver(fn: (() => string[]) | null): void { _changeoverFieldsResolver = typeof fn === 'function' ? fn : null; },

  /** The task fields whose change between adjacent orders is a changeover, for
   *  the plant currently being scheduled. Resolved through the injected seam so
   *  this stays the SAME list `Engine._sortTerms` actually sequences on; falls
   *  back to COLOR/FORM_SIZE when unwired. Exported (not just used internally)
   *  so the alert cell-briefing's own adjacent-order count can share it rather
   *  than keeping a second hardcoded copy. */
  changeoverFields(): readonly string[] {
    if (!_changeoverFieldsResolver) return _DEFAULT_CHANGEOVER_FIELDS;
    try {
      const f = _changeoverFieldsResolver();
      return (Array.isArray(f) && f.length) ? f : _DEFAULT_CHANGEOVER_FIELDS;
    } catch { return _DEFAULT_CHANGEOVER_FIELDS; }
  },
  locale(): string { return _locale; },
  setLocale(lang: string): void { _locale = lang; },

  // Safe Date parser. Accepts Date | ISO | null. Returns Date or null.
  parseDate(v: unknown): Date | null {
    if (!v) return null;
    if (v instanceof Date) return isNaN(Number(v)) ? null : v;
    const d = new Date(v as string | number | Date);
    return isNaN(Number(d)) ? null : d;
  },

  // Snap a Date to the nearest STEP_MS boundary.
  snap(date: Date | number | string): Date {
    const t = date instanceof Date ? date.getTime() : new Date(date).getTime();
    return new Date(Math.round(t / Config.STEP_MS) * Config.STEP_MS);
  },

  // YYYY-MM-DD key (local time) for bucketing by day.
  dayKey(d: unknown): string {
    const date = Util.parseDate(d);
    if (!date) return '';
    const p = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
  },

  // Pretty date for display (e.g. "2026-04-22 09:15").
  fmtDT(d: unknown): string {
    const date = Util.parseDate(d);
    if (!date) return '';
    const p = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} `
         + `${p(date.getHours())}:${p(date.getMinutes())}`;
  },

  // ── DISPLAY-ONLY format prefs (was Store.pref, now the injected resolver) ──
  // Resolve the user's timeFormat/dateFormat preference with safe fallbacks for
  // when the resolver isn't wired yet. These never touch stored data — they only
  // change how a Date is rendered (see the timezone caution: timeFormat/dateFormat
  // are display-only, save/parse/compute paths stay untouched).
  _timeFormatPref(): string {
    try { return _prefResolver('timeFormat') || '12h'; } catch { return '12h'; }
  },
  _dateFormatPref(): string {
    try { return _prefResolver('dateFormat') || 'M j, Y'; } catch { return 'M j, Y'; }
  },
  // Format a Date's time part per timeFormat: 12h ("6 PM" / "6:30 PM") or 24h ("18:30").
  _fmtTimePref(date: Date): string {
    const min = date.getMinutes();
    if (Util._timeFormatPref() === '24h') {
      const p = (n: number) => String(n).padStart(2, '0');
      return `${p(date.getHours())}:${p(min)}`;
    }
    const h24 = date.getHours();
    const ampm = h24 < 12 ? 'AM' : 'PM';
    const h12 = h24 % 12 || 12;
    const minStr = min === 0 ? '' : `:${String(min).padStart(2, '0')}`;
    return `${h12}${minStr} ${ampm}`;
  },
  // Format a Date's date part per the Flatpickr-token dateFormat pref, via the
  // Flatpickr static formatter; falls back to compact MM/DD/YY if unavailable.
  _fmtDatePref(date: Date): string {
    const tok = Util._dateFormatPref();
    try {
      if (typeof flatpickr !== 'undefined' && flatpickr.formatDate) return flatpickr.formatDate(date, tok);
    } catch { /* fall through to legacy compact format */ }
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(date.getMonth() + 1)}/${p(date.getDate())}/${String(date.getFullYear()).slice(-2)}`;
  },
  // Human-readable datetime (e.g. "May 15, 2026 · 6 PM"), routed through the
  // per-user dateFormat + timeFormat display prefs.
  fmtDTReadable(d: unknown): string {
    const date = Util.parseDate(d);
    if (!date) return '';
    return `${Util._fmtDatePref(date)} · ${Util._fmtTimePref(date)}`;
  },

  // Compact range for blackout rows. Same day: "05/15/26 · 6–7 PM". Multi-day: "05/15/26 → 05/17/26".
  fmtBlockRange(s: unknown, e: unknown): string {
    const ds = Util.parseDate(s), de = Util.parseDate(e);
    if (!ds || !de) return '';
    const p = (n: number) => String(n).padStart(2, '0');
    const dateStr = (d: Date) => `${p(d.getMonth()+1)}/${p(d.getDate())}/${String(d.getFullYear()).slice(-2)}`;
    const sameDay = ds.getFullYear() === de.getFullYear()
                 && ds.getMonth()    === de.getMonth()
                 && ds.getDate()     === de.getDate();
    const fmtTime = (h24: number, min: number) => {
      const ampm = h24 < 12 ? 'AM' : 'PM';
      const h12  = h24 % 12 || 12;
      const m    = min === 0 ? '' : `:${String(min).padStart(2,'0')}`;
      return `${h12}${m}${ampm}`;
    };
    if (sameDay) {
      const sAmpm = ds.getHours() < 12 ? 'AM' : 'PM';
      const eAmpm = de.getHours() < 12 ? 'AM' : 'PM';
      const sH    = ds.getHours() % 12 || 12;
      const eH    = de.getHours() % 12 || 12;
      const sM    = ds.getMinutes() === 0 ? '' : `:${String(ds.getMinutes()).padStart(2,'0')}`;
      const eM    = de.getMinutes() === 0 ? '' : `:${String(de.getMinutes()).padStart(2,'0')}`;
      const suffix = sAmpm === eAmpm ? `${sH}${sM}–${eH}${eM} ${eAmpm}` : `${sH}${sM}${sAmpm}–${eH}${eM}${eAmpm}`;
      return `${dateStr(ds)} · ${suffix}`;
    }
    return `${dateStr(ds)} ${fmtTime(ds.getHours(), ds.getMinutes())} → ${dateStr(de)} ${fmtTime(de.getHours(), de.getMinutes())}`;
  },

  /** Sum the hours of `intervals` ([{s:Date, e:Date}, …]) intersected with `win`
   *  ([Date, Date]), correctly unioning overlapping intervals so the same
   *  minutes are never counted twice. Returns hours. */
  mergedOverlapHours(win: [Date | number, Date | number] | null, intervals: Array<{ s: Date | number; e: Date | number }>): number {
    if (!win || !intervals?.length) return 0;
    const w0 = win[0] instanceof Date ? win[0].getTime() : +win[0];
    const w1 = win[1] instanceof Date ? win[1].getTime() : +win[1];
    if (w1 <= w0) return 0;
    const clipped = [];
    for (const it of intervals) {
      if (!it?.s || !it?.e) continue;
      const s = Math.max(w0, it.s instanceof Date ? it.s.getTime() : +it.s);
      const e = Math.min(w1, it.e instanceof Date ? it.e.getTime() : +it.e);
      if (e > s) clipped.push([s, e]);
    }
    if (!clipped.length) return 0;
    clipped.sort((a, b) => a[0] - b[0]);
    let total = 0;
    let curS = clipped[0][0], curE = clipped[0][1];
    for (let i = 1; i < clipped.length; i++) {
      const [s, e] = clipped[i];
      if (s <= curE) curE = Math.max(curE, e);
      else { total += curE - curS; curS = s; curE = e; }
    }
    total += curE - curS;
    return total / Config.MS_HOUR;
  },

  // "2h 30m"
  fmtHours(hours: number | null | undefined): string {
    if (hours == null || isNaN(hours)) return '—';
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    if (h === 0) return `${m}m`;
    if (m === 0) return `${h}h`;
    return `${h}h ${m}m`;
  },

  // Convert a Date to <input type="datetime-local"> value.
  toLocalInput(d: unknown): string {
    const date = Util.parseDate(d);
    if (!date) return '';
    const p = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
         + `T${p(date.getHours())}:${p(date.getMinutes())}`;
  },

  // Convert a Date to a naive local-time string (no timezone marker), for
  // sending a date to the backend without going through JSON.stringify's
  // default Date serialization. Deliberately NOT `date.toISOString()` —
  // that converts to UTC, and brain.py's `_to_pydt` strips the resulting tz
  // label WITHOUT converting the clock digits back to local, silently
  // corrupting the value by the client's UTC offset for any non-UTC user.
  // Preserves seconds (unlike toLocalInput, which only goes to minute
  // precision) since callers may encode sub-minute information in the
  // seconds field.
  toLocalSeconds(d: unknown): string {
    const date = Util.parseDate(d);
    if (!date) return '';
    const p = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
         + `T${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
  },

  // Flatpickr datetime-picker factory — single source for the NIMBUS amber
  // datetime config (30-min step, alt display). `extra` extends/overrides
  // (e.g. an onChange handler). Accepts a selector string or element; returns
  // the flatpickr instance. The date-only (Printer/AdminCockpit) and
  // OptimizeDialog (1-min, inline) pickers intentionally do NOT use this.
  // Display-only altFormat, routed through the dateFormat + timeFormat prefs
  // (machine `dateFormat` below is unchanged — parse/save paths untouched).
  _fpAltFormat(): string {
    const df = Util._dateFormatPref();
    const tf = Util._timeFormatPref();
    return `${df} · ${tf === '24h' ? 'H:i' : 'h:i K'}`;
  },
  fpDatetime(sel: string | HTMLElement, extra: Record<string, unknown> = {}) {
    return flatpickr(sel, {
      enableTime: true, dateFormat: 'Y-m-d\\TH:i',
      altInput: true, altFormat: Util._fpAltFormat(), minuteIncrement: 30,
      ...extra,
    });
  },

  // Clamp a Date to a [min,max] window.
  clamp(d: Date, min: Date | null | undefined, max: Date | null | undefined): Date {
    const t = d.getTime();
    if (min && t < min.getTime()) return new Date(min);
    if (max && t > max.getTime()) return new Date(max);
    return d;
  },

  // Normalise a string for case-insensitive compares.
  norm(s: unknown): string { return (s ?? '').toString().trim().toUpperCase(); },

  // User-facing order identifier. Backend task payloads expose the business
  // order number as ORDER; PRODUCTION_ORDER remains a legacy compatibility
  // field. Never fall back to the internal task ID in visible copy.
  orderNumber(task: Pick<NimbusTask, 'ORDER' | 'PRODUCTION_ORDER'> | null | undefined, fallback = 'order number unavailable'): string {
    const order = String(task?.ORDER ?? '').trim() || String(task?.PRODUCTION_ORDER ?? '').trim();
    return order || fallback;
  },

  // Get run-time (hours) from a task; 0 if missing.
  runHours(task: NimbusTask): number {
    const v = parseFloat(task?.RUN_TIME as string);
    return isNaN(v) ? 0 : v;
  },

  /** Single browser-facing reader for productive order intervals. The UMD core
   * owns the implementation so workers, Node tests, and the main thread agree. */
  scheduleIntervals(task: NimbusTask): Array<{ sequence: number; start: Date; end: Date }> {
    const core = globalThis.NimbusComputeCore;
    if (core?.scheduleIntervals) return core.scheduleIntervals(task);
    const start = Util.parseDate(task?.start_date);
    const end = Util.parseDate(task?.end_date);
    return start && end && end > start ? [{ sequence: 1, start, end }] : [];
  },

  // Start of local day.
  startOfDay(d: unknown): Date | null { const x = Util.parseDate(d); if (!x) return null; x.setHours(0,0,0,0); return x; },

  // Add minutes.
  addMin(d: Date, min: number): Date { return new Date(d.getTime() + min * Config.MS_MIN); },

  // Short, stable id (used for blocks / alerts).
  uid(prefix?: string): string {
    return `${prefix || 'x'}-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36).slice(-4)}`;
  },

  // Simple debounce.
  debounce<A extends unknown[]>(fn: (...args: A) => void, wait: number): (...args: A) => void {
    let t: ReturnType<typeof setTimeout>;
    return (...a: A) => { clearTimeout(t); t = setTimeout(() => fn(...a), wait); };
  },

  // Deep-ish clone for plain objects + Dates.
  clone<T>(obj: T): T {
    if (obj == null || typeof obj !== 'object') return obj;
    if (obj instanceof Date) return new Date(obj) as unknown as T;
    if (Array.isArray(obj)) return obj.map(Util.clone) as unknown as T;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj as Record<string, unknown>)) out[k] = Util.clone((obj as Record<string, unknown>)[k]);
    return out as unknown as T;
  },

  // Traced fetch — attaches an x-request-id and logs slow/failed responses through ErrorLog.
  // Drop-in replacement for fetch() everywhere in the app.
  fetchTraced(input: RequestInfo, init: RequestInit = {}): Promise<Response> {
    const reqId = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    const headers = new Headers(init.headers || {});
    if (!headers.has('x-request-id')) headers.set('x-request-id', reqId);
    if (!headers.has('x-user-email') && !headers.has('X-User')) headers.set('x-user-email', _actorResolver() as string);
    const method = init.method || 'GET';
    const url    = typeof input === 'string' ? input : input.url;
    const t0     = performance.now();
    return fetch(input, { ...init, headers }).then(r => {
      const ms = Math.round(performance.now() - t0);
      if (!r.ok) {
        // Best-effort drain of the error body to extract a backend message — clone()
        // so the caller still gets an unread body. json() first, then text() fallback.
        const clone = (() => { try { return r.clone(); } catch { return null; } })();
        const drain = clone
          ? clone.json().then(
              j => (j && (j.message || j.detail)) || null,
              () => clone.text().then(txt => (txt || '').slice(0, 2000) || null, () => null)
            )
          : Promise.resolve(null);
        drain.then(backendMessage => {
          const tail = backendMessage ? `: ${backendMessage}` : '';
          ErrorLog.warn('http', `${method} ${url} → ${r.status} (${ms}ms)${tail}`,
            { reqId, status: r.status, url, method, ms, backendMessage },
            { reqId, errorCode: 'http.status' });
        });
      } else if (ms > 2000) {
        ErrorLog.info('http', `slow: ${method} ${url} ${ms}ms`, { reqId, url, method, ms });
      }
      return r;
    }).catch(e => {
      if (e?.name === 'AbortError') throw e;
      ErrorLog.error('http', `${method} ${url} failed: ${e.message}`,
        { reqId, url, method, error: String(e?.message || e) },
        { reqId, errorCode: 'http.network' });
      throw e;
    });
  },

  // Parse a non-ok Response body into a structured {message, errorCode, status}.
  // Best-effort: clones the response (caller keeps the body), reads json() then text().
  // Used by raw-fetch migration sites so each surfaces the parsed backend body.
  parseBackendError(resp: Response | null | undefined): Promise<{ message: string; errorCode: string; status: number }> {
    const status = resp?.status ?? 0;
    const clone  = (() => { try { return resp?.clone() ?? null; } catch { return null; } })();
    const read   = clone
      ? clone.json().then(
          j => ({ message: (j && (j.message || j.detail)) || null, errorCode: (j && j.error_code) || null }),
          () => clone.text().then(txt => ({ message: (txt || '').slice(0, 2000) || null, errorCode: null }), () => ({ message: null, errorCode: null }))
        )
      : Promise.resolve({ message: null, errorCode: null });
    return read.then(({ message, errorCode }) => ({
      message: message || `HTTP ${status}`,
      errorCode: errorCode || 'http.status',
      status,
    }));
  },

  // SAP planning baseline finish. NIMBUS keeps this in `original_end_date`
  // (set once from ORIGINAL_END_DATE; what the variance badge compares against).
  sapDueDate(t: NimbusTask): Date | null {
    return t?.original_end_date || null;
  },

  // Scheduled finish for a task — user override `end_date` if present, otherwise the SAP baseline.
  scheduledEnd(t: NimbusTask): Date | null {
    return t?.end_date || Util.sapDueDate(t);
  },

  // Display-only derived "Original Start": due date minus RUN_TIME, so
  // Orig Start and Orig End always form a runtime-consistent pair (e.g.
  // RUN_TIME 1h, due 7:00 PM -> Orig Start 6:00 PM) instead of the raw
  // midnight SAP date. Falls back to the raw original_start_date (coerced
  // to a Date) when there's no due date to anchor on. Pure/cheap — no
  // Calendar lookup, no persistence — and never writes back to the task:
  // original_start_date itself stays untouched because it's load-bearing
  // for _snapToWorkingHours's startMoved guard and _overlayUserMoves's
  // move-detection. Edge case (not clamped, deliberately): an order whose
  // RUN_TIME exceeds the gap between midnight and its due time will show
  // an implied start before midnight (the previous calendar day).
  impliedOriginalStart(t: NimbusTask): Date | null {
    const due = Util.sapDueDate(t);
    if (!due) {
      return t?.original_start_date instanceof Date ? t.original_start_date : Util.parseDate(t?.original_start_date);
    }
    return new Date(due.getTime() - Util.runHours(t) * Config.MS_HOUR);
  },

  // Hours that scheduled finish slips past the SAP planning date (clamped at 0).
  latenessHours(t: NimbusTask): number {
    const end = Util.scheduledEnd(t);
    const due = Util.sapDueDate(t);
    if (!end || !due) return 0;
    const diff = (end.getTime() - due.getTime()) / Config.MS_HOUR;
    return diff > 0 ? diff : 0;
  },

  // Adjacent-order changeover count across the schedule, grouped by line.
  // A "changeover" = neighbours differ in ANY of the fields the plant actually
  // sequences on (Util.changeoverFields() -> Engine.changeoverTaskFields via the
  // injected seam): every active priority field's task field, plus FORM_SIZE.
  //
  // Was hardcoded to COLOR/FORM_SIZE, which made this KPI blind to the three
  // fields Stage 3 wired into the optimizer. Since this number is what the
  // Optimizer Preview shows the planner to decide Apply vs Discard, a plant
  // sequencing on PRT_01 saw a flat-or-worse count for a run that genuinely cut
  // tooling changeovers — regrouping by tooling necessarily reshuffles colors —
  // and was pushed toward discarding a correct optimization.
  //
  // Combination rule: ANY differing active field = ONE changeover. That is a
  // straight generalization of the `COLOR !== COLOR || FORM_SIZE !== FORM_SIZE`
  // it replaces (same "or", more operands), so a never-configured plant's count
  // is unchanged. It deliberately does NOT sum per-field counts or weight by
  // priority depth — a physical changeover between two orders is one event, and
  // weighting needs the setup/teardown cost matrix that is 1-2 years out
  // (docs/scheduling_priority.md, "PRT vs. cost").
  countChangeovers(tasks: NimbusTask[]): number {
    const byLine: Record<string, NimbusTask[]> = {};
    for (const t of tasks) {
      if (!t.start_date) continue;
      const l = t.PRODUCTION_LINE || 'Unknown';
      (byLine[l] ||= []).push(t);
    }
    const fields = Util.changeoverFields();
    let n = 0;
    for (const l of Object.keys(byLine)) {
      const sorted = byLine[l].sort((a, b) => Number(a.start_date) - Number(b.start_date));
      for (let i = 1; i < sorted.length; i++) {
        const a = sorted[i - 1] as unknown as Record<string, unknown>;
        const b = sorted[i]     as unknown as Record<string, unknown>;
        // `|| ''` (not `?? ''`), preserving the exact coercion the hardcoded
        // COLOR/FORM_SIZE comparison used, so a blank/null/absent value stays
        // equal to any other blank rather than becoming a changeover. Left as a
        // raw compare rather than Util.norm: normalizing case/whitespace here
        // would also be defensible (it is what _sortTerms does) but would shift
        // every existing plant's baseline count, which is outside this fix.
        if (fields.some(f => (a[f] || '') !== (b[f] || ''))) n++;
      }
    }
    return n;
  },

  // Composite KPIs for the optimizer preview. Pure: takes a task array, no Store access.
  // Returns { changeovers, span_h, late_count, late_h, peak_util_pct }.
  scheduleKpis(tasks: NimbusTask[], horizonDays: number = 14, utilizationContext?: unknown): { changeovers: number; span_h: number; late_count: number; late_h: number; peak_util_pct: number } {
    const changeovers = Util.countChangeovers(tasks);
    let minStart = Infinity, maxEnd = -Infinity;
    let lateCount = 0, lateH = 0;
    for (const t of tasks) {
      if (t.start_date) minStart = Math.min(minStart, t.start_date.getTime());
      const e = Util.scheduledEnd(t);
      if (e) maxEnd = Math.max(maxEnd, e.getTime());
      const lh = Util.latenessHours(t);
      if (lh > 0) { lateCount++; lateH += lh; }
    }
    const span_h = (minStart === Infinity || maxEnd === -Infinity) ? 0 : (maxEnd - minStart) / Config.MS_HOUR;
    // Peak utilization from the existing Utilization matrix (via the injected resolver).
    let peak = 0;
    try {
      if (!_utilizationResolver) throw new Error('utilization resolver not wired');
      const m = _utilizationResolver(new Date(), horizonDays, tasks, utilizationContext);
      for (const ln of Object.keys(m)) {
        for (const d of Object.keys(m[ln])) {
          const p = m[ln][d]?.pct || 0;
          if (p > peak) peak = p;
        }
      }
    } catch { /* matrix unavailable — leave peak at 0 */ }
    return {
      changeovers,
      span_h: Math.round(span_h * 10) / 10,
      late_count: lateCount,
      late_h:    Math.round(lateH * 10) / 10,
      peak_util_pct: Math.round(peak * 100),
    };
  },

  t(key: string, vars?: Record<string, string | number>): string {
    const dict: Record<string, string> = window.__NIMBUS_LOCALES?.[_locale] || {};
    const en: Record<string, string>   = window.__NIMBUS_LOCALES?.en || {};
    let str = dict[key] ?? en[key] ?? key;
    if (vars) str = str.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? ''));
    return str;
  },

  // Plant-local wall clock, shared by the dashboard greeting's time-of-day
  // bucket and the nav-drawer plant clock. Intl.DateTimeFormat throws
  // RangeError on an empty/invalid IANA zone — that catch IS the contract:
  // callers get zoned:false and a viewer-local fallback rather than a crash.
  plantNowParts(tz?: string | null): { hour: number; minute: number; hhmm: string; zoned: boolean } {
    const now = new Date();
    const z = (tz ?? '').trim();
    if (z) {
      try {
        const parts = new Intl.DateTimeFormat('en-GB',
          { timeZone: z, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now);
        const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
        const hh = get('hour'), mm = get('minute');
        if (hh && mm) return { hour: (+hh) % 24, minute: +mm, hhmm: `${hh}:${mm}`, zoned: true };
      } catch { /* invalid IANA zone — fall through to viewer-local */ }
    }
    const p2 = (n: number) => String(n).padStart(2, '0');
    return {
      hour: now.getHours(), minute: now.getMinutes(),
      hhmm: `${p2(now.getHours())}:${p2(now.getMinutes())}`, zoned: false,
    };
  },

  // Required DOM element getter — throws if element not found.
  reqEl(id: string): HTMLElement {
    const el = document.getElementById(id);
    if (!el) throw new Error(`required DOM element missing: ${id}`);
    return el;
  },

  // Strips the ".0" suffix Excel appends to General-formatted numeric columns
  // (e.g. "1000261702.0"), mirroring backend _clean_id() (brain.py) so pasted
  // SAP-style ids match what's actually stored on tasks.
  _stripExcelFloatSuffix(s: string): string {
    return /^-?\d+\.0$/.test(s) ? s.slice(0, -2) : s;
  },

  // Parse clipboard text pasted from Excel into a flat list of candidate
  // strings. Same \r-strip/\n-split/\t-split convention as the labor-grid
  // paste handler and MasterData._parsePaste, flattened to one list since
  // paste-to-filter only needs "the set of strings the user pasted".
  parsePasteList(text: string | null | undefined): string[] {
    if (!text) return [];
    return text.replace(/\r/g, '').split('\n')
      .flatMap(line => line.split('\t'))
      .map(v => Util._stripExcelFloatSuffix(v.trim()))
      .filter(Boolean);
  },

  // Match parsed paste text against a live list of checkbox elements (by
  // .value, case-insensitive/trimmed), check the matches, and dispatch a
  // bubbling 'change' on each newly-checked box so the panel's own
  // onchange="..." handler does the Set-update + apply work — no separate
  // "select" logic to keep in sync.
  matchPasteToCheckboxes(text: string, checkboxEls: HTMLInputElement[]): { matched: number; total: number } {
    const distinct = [...new Set(Util.parsePasteList(text).map(Util.norm))];
    const byValue = new Map();
    checkboxEls.forEach(cb => byValue.set(Util.norm(cb.value), cb));
    let matched = 0;
    distinct.forEach(v => {
      const cb = byValue.get(v);
      if (!cb) return;
      matched++;
      if (!cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }
    });
    return { matched, total: distinct.length };
  },

  // One-time wiring for a small paste-capture <input> sitting atop a
  // checkbox panel. getCheckboxEls is called lazily at paste-time so it
  // always sees the panel's current (rebuilt) checkbox list.
  wirePasteToCheckboxes(inputEl: PasteWiredInput, getCheckboxEls: () => HTMLInputElement[]): void {
    if (!inputEl || inputEl._pasteWired) return;
    inputEl._pasteWired = true;
    inputEl.addEventListener('paste', e => {
      e.preventDefault();
      const text = (e.clipboardData || (window as unknown as { clipboardData?: DataTransfer }).clipboardData)!.getData('text/plain');
      inputEl.value = '';
      if (!text || !text.trim()) return;
      const { matched, total } = Util.matchPasteToCheckboxes(text, getCheckboxEls());
      if (!total) return;
      Toast.show(Util.t('toast.paste_checkbox_match', { matched, total }), matched > 0 ? 'success' : 'warn');
    });
  },

  // Sub-feature B predicate shared by GanttFilter.matches() and
  // Table._taskPassesChipFilters(). Frontend task objects carry the
  // production order as .ORDER (brain.py aliases PRODUCTION_ORDER -> ORDER
  // in the /tasks response) — .PRODUCTION_ORDER is kept as a fallback only
  // for parity with the same convention used by Table's own valueGetter.
  taskMatchesPasteSet(task: NimbusTask, idSet: Set<string> | null | undefined): boolean {
    if (!idSet || idSet.size === 0) return true;
    const po  = Util.norm(task.ORDER ?? task.PRODUCTION_ORDER);
    const mat = Util.norm(task.MATERIAL_NUMBER);
    return !!((po && idSet.has(po)) || (mat && idSet.has(mat)));
  },

  // Shared search+checkbox "N selected" multi-select combobox — the pattern
  // GanttFilter/Table/Dashboard's line pickers already used independently
  // (and, since the cross-screen production-line filter, Labor Planning's
  // and Master Data > Production Lines' line pickers too). Renders checkboxes
  // for `candidateLines` (filtered by `search`, case-insensitive substring)
  // checked per `selected.has(line)`, and wires each box's change event to
  // `onToggle` — the caller owns what happens next (Store mutation, re-render
  // of dependents, etc). Deliberately does NOT prune `selected` down to
  // `candidateLines` the way the old per-screen copies did: `selected` is
  // now a single Set shared across five screens with five different
  // candidate universes (see docs note on Store.selectedLines), so one
  // screen unilaterally dropping an entry it doesn't recognize would fight
  // with the others. A selected line invisible to the current screen's
  // candidate list simply renders unchecked there — harmless.
  // Optional 6th param, additive: `cap` bounds the rendered/delegated-listener
  // count (undefined = today's unlimited behavior, unchanged for all existing
  // callers); `emptyKey` overrides the empty-candidates i18n key (was a
  // hardcoded English 'No lines' literal — a real bug for any non-line reuse,
  // now `ui.no_lines` by default, same text); `onCapped(shown, total)` lets a
  // caller surface "showing N of M" when the cap actually trims the list.
  // Event delegation (one listener on checklistEl, not one per checkbox) is
  // what makes `cap` meaningful for a huge candidate list — needed because a
  // per-checkbox listener count at candidate-list scale (tens of thousands)
  // is itself the freeze this is guarding against. Delegation still catches
  // paste-driven checks: matchPasteToCheckboxes dispatches a bubbling
  // 'change' (see below), which a delegated listener on the container catches
  // exactly like a direct one would.
  renderLineChecklist(
    checklistEl: HTMLElement | null,
    candidateLines: string[],
    selected: Set<string>,
    search: string,
    onToggle: (line: string, checked: boolean) => void,
    opts?: { cap?: number; emptyKey?: string; onCapped?: (shown: number, total: number) => void },
  ): void {
    if (!checklistEl) return;
    const q = (search || '').toLowerCase().trim();
    const matched = q ? candidateLines.filter(l => l.toLowerCase().includes(q)) : candidateLines;
    const cap = opts?.cap;
    const visible = cap != null && matched.length > cap ? matched.slice(0, cap) : matched;
    const esc = (s: unknown) => String(s).replace(/[&<>"]/g,
      (c: string) => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as Record<string, string>)[c]));
    checklistEl.innerHTML = visible.length
      ? visible.map(l =>
          `<label><input type="checkbox" value="${esc(l)}"${selected.has(l) ? ' checked' : ''}> ${esc(l)}</label>`
        ).join('')
      : `<div style="padding:8px 14px;font-size:12px;color:#9a9285">${candidateLines.length ? Util.t('ui.no_matches') : Util.t(opts?.emptyKey ?? 'ui.no_lines')}</div>`;
    if (!(checklistEl as HTMLElement & { _delegated?: boolean })._delegated) {
      (checklistEl as HTMLElement & { _delegated?: boolean })._delegated = true;
      checklistEl.addEventListener('change', (e) => {
        const cb = e.target as HTMLInputElement;
        if (cb?.type === 'checkbox') onToggle(cb.value, cb.checked);
      });
    }
    if (visible.length < matched.length) opts?.onCapped?.(visible.length, matched.length);
  },

  // Updates a line multi-select's trigger button label/active state — "All
  // lines" / the one selected name / "N lines" — shared by every line-picker
  // button (companion to renderLineChecklist above). Optional `opts` bag lets
  // a non-line reuse override the two i18n keys (and interpolation vars) so
  // the label can read e.g. "All Material Types" / "3 selected" instead of
  // being hardcoded to line semantics. Omitted entirely, behavior is
  // unchanged from before this param existed.
  refreshMultiSelectLabel(
    labelEl: HTMLElement | null,
    btnEl: HTMLElement | null,
    selected: Set<string>,
    opts?: { allKey?: string; allVars?: Record<string, string | number>;
             nKey?: string; nVars?: Record<string, string | number> },
  ): void {
    if (!labelEl) return;
    const n = selected.size;
    labelEl.textContent = n === 0 ? Util.t(opts?.allKey ?? 'ui.all_lines', opts?.allVars)
      : n === 1 ? [...selected][0]
      : Util.t(opts?.nKey ?? 'ui.n_lines_filter', { count: n, ...(opts?.nVars ?? {}) });
    if (btnEl) btnEl.classList.toggle('active', n > 0);
  },

  // Diagnostic "how many of these pasted values matched a known id" count,
  // used for the paste toast on the Production Order / Material filter.
  countPasteMatches(text: string, knownIdSet: Set<string>): { matched: number; total: number } {
    const distinct = [...new Set(Util.parsePasteList(text).map(Util.norm))];
    return { matched: distinct.filter(v => knownIdSet.has(v)).length, total: distinct.length };
  },

  // Fractional-hours <-> "HH:MM" string conversion, shared by CalendarUI
  // (blackout-block-tab UI, stays in app.js) and EditCalendar/ColorWheelViewer
  // (schedule-workbench.mjs) — previously duplicated as CalendarUI's private
  // _hToT/_tToH (CQ-1 Phase 3 Task 7).
  hoursToTimeString(h: number): string {
    const hh = Math.floor(h), mm = Math.round((h - hh) * 60);
    return `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
  },
  timeStringToHours(t: string): number {
    const [h, m] = t.split(':').map(Number);
    return h + (m / 60);
  },
};

/* =============================================================================
   VIRTUAL LIST — minimal padding-based windowing helper.
   Renders only the items visible in the scroll viewport plus a buffer,
   using paddingTop/paddingBottom spacers so the scrollbar reflects true height.

   Usage (fixed height):
     const vl = new VirtualList(scrollEl, { rowH: 36, renderFn: (item) => '<div>...</div>' });
     vl.update(items);

   Usage (variable height — e.g. expandable rows):
     const vl = new VirtualList(scrollEl, { getRowH: (item) => item.open ? 120 : 36, renderFn });
     vl.update(items);
   ========================================================================== */
export class VirtualList<T = unknown> {
  _scroll: HTMLElement;
  _mount: HTMLElement;
  _fixedH: number | null;
  _getRowH: ((item: T) => number) | null;
  _renderFn: (item: T, index: number) => string;
  _buf: number;
  _items: T[];
  _offsets: Float64Array | null;
  _inner: HTMLDivElement;
  _onScroll: () => void;
  // Remembered scroll offset, independent of whatever the browser clamps
  // scrollTop to when the list shrinks. _onScroll only updates this on a
  // genuine user-driven scroll (guarded by _applying below); update() then
  // re-applies it after painting instead of trusting the post-clamp value.
  _desiredTop: number;
  _applying: boolean;
  // Set when update() runs against a zero-height container (tab panel is
  // display:none). The anchor restore is deferred — computing it against
  // the `|| 600` fallback viewport would land at a bogus position — until
  // the next update() or an explicit restoreTop() call finds real layout.
  _pendingAnchor: boolean;

  constructor(scrollEl: HTMLElement, { rowH, getRowH, renderFn, mountEl, buffer = 5 }: VirtualListOptions<T>) {
    this._scroll   = scrollEl;
    this._mount    = mountEl || scrollEl;
    this._fixedH   = typeof rowH === 'number' ? rowH : null;
    this._getRowH  = getRowH || null;
    this._renderFn = renderFn;
    this._buf      = buffer;
    this._items    = [];
    this._offsets  = null;
    this._inner    = document.createElement('div');
    this._mount.appendChild(this._inner);
    this._desiredTop    = 0;
    this._applying      = false;
    this._pendingAnchor = false;
    this._onScroll = () => {
      // A programmatic write (from update()'s re-anchor, or scrollToTop/
      // restoreTop) also fires 'scroll' — ignore those so they don't
      // clobber the just-set _desiredTop with the same value re-read.
      if (!this._applying) this._desiredTop = this._scroll.scrollTop;
      this._paint();
    };
    scrollEl.addEventListener('scroll', this._onScroll, { passive: true });
  }

  update(items: T[], opts?: { anchor?: 'preserve' | 'top' }): void {
    this._items = items;
    if (opts && opts.anchor === 'top') this._desiredTop = 0;
    if (this._getRowH) {
      const n = items.length;
      this._offsets = new Float64Array(n + 1);
      for (let i = 0; i < n; i++) {
        this._offsets[i + 1] = this._offsets[i] + this._getRowH(items[i]);
      }
    }
    this._paint();

    // Zero-height guard: painted while the tab panel is display:none.
    // clientHeight would read 0, so the max-scroll clamp below would be
    // computed against the `|| 600` fallback in _paint() and land wrong.
    // Defer the anchor write until a real update()/restoreTop() sees layout.
    if (this._scroll.clientHeight === 0) {
      this._pendingAnchor = true;
      return;
    }
    this._pendingAnchor = false;

    // Re-anchor to the remembered offset, clamped to the list's new max
    // scroll. This is what stops a shrinking list from sticking to the
    // browser's post-clamp scrollTop (which is the bottom).
    const maxTop = Math.max(0, this._totalH() - (this._scroll.clientHeight || 600));
    const clamped = Math.max(0, Math.min(this._desiredTop, maxTop));
    this._desiredTop = clamped;
    if (this._scroll.scrollTop !== clamped) {
      this._applying = true;
      this._scroll.scrollTop = clamped;
      this._applying = false;
      this._paint();
    }
  }

  // Force the list to the top — used on first population or when the list's
  // identity changes (different plant, different filter) so a stale offset
  // from the previous content isn't re-applied.
  scrollToTop(): void {
    this._desiredTop = 0;
    this._pendingAnchor = false;
    this._applying = true;
    this._scroll.scrollTop = 0;
    this._applying = false;
    this._paint();
  }

  // Session-scoped scroll memory (A2): callers capture/replay _desiredTop
  // around a tab switch rather than reading/writing this._scroll directly,
  // so the list's own window repaints to match instead of just the raw pixel.
  saveTop(): number {
    return this._desiredTop;
  }

  restoreTop(top: number): void {
    this._desiredTop = top;
    if (this._scroll.clientHeight === 0) {
      // Still hidden — defer, same as the update() guard above.
      this._pendingAnchor = true;
      return;
    }
    this._pendingAnchor = false;
    const maxTop = Math.max(0, this._totalH() - (this._scroll.clientHeight || 600));
    const clamped = Math.max(0, Math.min(top, maxTop));
    this._desiredTop = clamped;
    this._applying = true;
    this._scroll.scrollTop = clamped;
    this._applying = false;
    this._paint();
  }

  _totalH(): number {
    if (this._fixedH !== null) return this._items.length * this._fixedH;
    return this._offsets ? this._offsets[this._items.length] : 0;
  }

  _offsetOf(i: number): number {
    if (this._fixedH !== null) return i * this._fixedH;
    return this._offsets ? this._offsets[i] : 0;
  }

  _paint(): void {
    const n = this._items.length;
    if (!n) {
      this._inner.style.paddingTop = '0';
      this._inner.style.paddingBottom = '0';
      this._inner.innerHTML = '';
      return;
    }
    const scrollTop = this._scroll.scrollTop;
    const viewH     = this._scroll.clientHeight || 600;
    const buf       = this._buf;
    let lo: number, hi: number;

    if (this._fixedH !== null) {
      lo = Math.max(0, Math.floor(scrollTop / this._fixedH) - buf);
      hi = Math.min(n, Math.ceil((scrollTop + viewH) / this._fixedH) + buf);
    } else {
      // Binary search for first item whose bottom edge is below scrollTop.
      // Non-null assertions below: this branch is only reachable when
      // _fixedH === null, which only happens when the caller passed
      // getRowH — and update() always populates _offsets before _paint()
      // can see a non-empty _items in that configuration (see the n === 0
      // early return above).
      let l = 0, r = n - 1;
      while (l < r) {
        const m = (l + r) >> 1;
        if (this._offsets![m + 1] <= scrollTop) l = m + 1; else r = m;
      }
      lo = Math.max(0, l - buf);
      // Walk forward until item top exceeds viewport bottom
      let e = lo;
      while (e < n && this._offsets![e] < scrollTop + viewH) e++;
      hi = Math.min(n, e + buf);
    }

    this._inner.style.paddingTop    = this._offsetOf(lo) + 'px';
    this._inner.style.paddingBottom = (this._totalH() - this._offsetOf(hi)) + 'px';

    let html = '';
    for (let i = lo; i < hi; i++) html += this._renderFn(this._items[i], i);
    this._inner.innerHTML = html;
  }

  destroy(): void {
    this._scroll.removeEventListener('scroll', this._onScroll);
    this._inner.remove();
    this._items = [];
  }
}

/* =============================================================================
   PERF MONITOR — ring-buffer profiler for main-thread operations.
   Records named operation durations and exposes rolling p50/p95/max stats.
   AdminCockpit "Thread" tab reads PerfMonitor.all() to render the task-manager view.
   ========================================================================== */
export const PerfMonitor = (() => {
  const _MAX = 100;
  const _buckets = new Map<string, PerfBucket>(); // name → { buf: Float32Array, head, count, last, lastTs }
  const _listeners = new Set<() => void>();
  let _notifyTimer: ReturnType<typeof setTimeout> | null = null;

  function record(name: string, ms: number): void {
    let b = _buckets.get(name);
    if (!b) {
      b = { buf: new Float32Array(_MAX), head: 0, count: 0, last: 0, lastTs: 0 };
      _buckets.set(name, b);
    }
    b.buf[b.head % _MAX] = ms;
    b.head++;
    b.count++;
    b.last   = ms;
    b.lastTs = Date.now();
    _notify();
  }

  function time<T>(name: string, fn: () => T): T {
    const t = performance.now();
    const r = fn();
    record(name, performance.now() - t);
    return r;
  }

  function stats(name: string): PerfStats | null {
    const b = _buckets.get(name);
    if (!b) return null;
    const n = Math.min(b.count, _MAX);
    const sorted = Array.from(b.buf.subarray(0, n)).sort((a, c) => a - c);
    return {
      last:   b.last,
      lastTs: b.lastTs,
      count:  b.count,
      p50:    sorted[Math.floor(n * 0.50)] ?? 0,
      p95:    sorted[Math.floor(n * 0.95)] ?? 0,
      max:    sorted[n - 1] ?? 0,
    };
  }

  function all(): Array<{ name: string } & PerfStats> {
    return [..._buckets.keys()].map(k => ({ name: k, ...(stats(k) as PerfStats) }));
  }

  function clear(): void { _buckets.clear(); _notify(); }
  function subscribe(fn: () => void): void { _listeners.add(fn); }

  function _notify(): void {
    if (_notifyTimer) return;
    _notifyTimer = setTimeout(() => { _notifyTimer = null; _listeners.forEach(fn => fn()); }, 250);
  }

  return { record, time, stats, all, clear, subscribe };
})();

/* =============================================================================
   ERROR LOG — structured in-memory log for the whole app.
     Levels: info | warn | error.  Caps at MAX entries.
     Exposed UI: badge in header + drawer. Keyboard: Ctrl+Alt+L.

   Four DI seams replace what used to be direct references from ErrorLog into
   modules that stay in app.js (Store, App, Session, AdminCockpit) — each
   defaults to a safe no-op/fallback matching the original try/catch-swallowed
   behavior:
     setPlantResolver(fn)      — feeds _plant() (was Store.selectedPlant)
     setRouteResolver(fn)      — feeds _route() (was App._currentTab/_ganttSub)
     setAdminGate(fn)          — feeds renderBadge()'s visibility gate (was Session.isAdmin())
     setBadgeClickHandler(fn)  — feeds the badge button's onclick (was App.goto + AdminCockpit.gotoOvTab)
   renderBadge() is public (renamed from the former _renderBadge — the two
   external call sites, Session._applyGates and _bootMain, plus the three
   internal self-references inside ErrorLog itself, all move to this name).
   ========================================================================== */
let _plantResolver: () => string | null = () => null;
let _routeResolver: () => { tab: string; ganttSub?: string } | null = () => null; // returns { tab, ganttSub } or null
let _adminGate: () => boolean = () => false;
let _badgeClick: () => void = () => {};

export const ErrorLog = {
  MAX: 500,
  _entries: [] as LogEntry[],
  _listeners: new Set<(e: LogEntry | { cleared: true }) => void>(),
  _recent: [] as RecentEntry[],            // rolling 60s window of {ts, level} for rate alarms
  _globalsInstalled: false,
  _droppedCount: 0,       // count of entries evicted past MAX (surfaced as an overflow marker)
  _breadcrumbs: [] as Breadcrumb[],       // rolling ring of recent typed Interaction events (see Interaction._log)
  BREADCRUMB_MAX: 15,
  // Per-page-load session id — generated once at module init so all entries from one
  // page load share an id (lets backend correlate a frontend batch to a session).
  SESSION_ID: (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,

  setPlantResolver(fn: () => string | null): void { _plantResolver = typeof fn === 'function' ? fn : () => null; },
  setRouteResolver(fn: () => { tab: string; ganttSub?: string } | null): void { _routeResolver = typeof fn === 'function' ? fn : () => null; },
  setAdminGate(fn: () => boolean): void { _adminGate = typeof fn === 'function' ? fn : () => false; },
  setBadgeClickHandler(fn: () => void): void { _badgeClick = typeof fn === 'function' ? fn : () => {}; },

  // -- Guarded cross-module accessors -------------------------------------
  // ErrorLog is defined early (before Store / App), so every reach into a
  // later module is wrapped — a not-yet-ready module must never make a log
  // push throw.
  _buildId(): string {
    // NIMBUS_BUILD_ID is the deploy build token; Config.BUILD_ID already mirrors it
    // (falling back to 'dev'). APP_VERSION lives in the cache-bust IIFE, out of scope here.
    try { return (typeof window !== 'undefined' && window.NIMBUS_BUILD_ID) || Config.BUILD_ID; }
    catch { return 'dev'; }
  },
  _plant(): string | null {
    try { return _plantResolver() || null; }
    catch { return null; }
  },
  _route(): string | null {
    try {
      const r = _routeResolver();
      if (!r) return null;
      const tab = r.tab || null;
      if (tab === 'gantt' && r.ganttSub) return `gantt/${r.ganttSub}`;
      return tab;
    } catch { return null; }
  },

  // Record a typed breadcrumb (called by Interaction._log). Cheap, always on.
  breadcrumb(type: string, data?: unknown): void {
    try {
      ErrorLog._breadcrumbs.push({ t: Date.now(), type, ...(data && typeof data === 'object' ? { d: data } : {}) });
      if (ErrorLog._breadcrumbs.length > ErrorLog.BREADCRUMB_MAX) {
        ErrorLog._breadcrumbs.splice(0, ErrorLog._breadcrumbs.length - ErrorLog.BREADCRUMB_MAX);
      }
    } catch {}
  },

  _push(level: LogLevel, scope: string, msg: string, ctx: unknown, opts?: LogOpts): void {
    // opts (all optional): { reqId, errorCode, stack } — explicit structured fields.
    const e: Partial<LogEntry> & Pick<LogEntry, 'ts' | 'level' | 'scope' | 'msg' | 'ctx'> = {
      ts: new Date().toISOString(),
      level, scope, msg,
      ctx: ctx === undefined ? null : ErrorLog._safeCtx(ctx),
    };
    // Additive structured fields. All optional — old readers ignore unknown keys.
    if (opts) {
      if (opts.reqId      != null) e.reqId      = opts.reqId;
      if (opts.errorCode  != null) e.errorCode  = opts.errorCode;
      if (opts.stack      != null) e.stack      = opts.stack;
    }
    // Central enrichment.
    if (level === 'error' && !e.stack) {
      try { e.stack = new Error().stack; } catch {}
    }
    e.buildId   = ErrorLog._buildId();
    e.sessionId = ErrorLog.SESSION_ID;
    const plant = ErrorLog._plant(); if (plant) e.plant = plant;
    const route = ErrorLog._route(); if (route) e.route = route;
    // Attach breadcrumbs to error-level entries for postmortem context.
    if (level === 'error' && ErrorLog._breadcrumbs.length) {
      e.ctx = ErrorLog._safeCtx({ ...(e.ctx && typeof e.ctx === 'object' ? e.ctx : (e.ctx != null ? { _ctx: e.ctx } : {})), breadcrumbs: ErrorLog._breadcrumbs.slice() });
    }

    ErrorLog._entries.push(e as LogEntry);
    if (ErrorLog._entries.length > ErrorLog.MAX) {
      const drop = ErrorLog._entries.length - ErrorLog.MAX;
      ErrorLog._entries.splice(0, drop);
      ErrorLog._droppedCount += drop;
    }
    ErrorLog._pushRecent(level);
    // mirror to console so power users see it
    const fn = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
    console[fn](`[${scope}]`, msg, ctx ?? '');
    for (const l of ErrorLog._listeners) { try { l(e as LogEntry); } catch {} }
    ErrorLog.renderBadge();
    ErrorLog._scheduleSave();
    if (level === 'error') ErrorLog._scheduleShip(e as LogEntry);
  },
  // Optional 4th arg `opts` carries structured {reqId, errorCode, stack}. Callers that
  // pass only (scope, msg, ctx) keep working unchanged.
  info (scope: string, msg: string, ctx?: unknown, opts?: LogOpts): void { ErrorLog._push('info',  scope, msg, ctx, opts); },
  warn (scope: string, msg: string, ctx?: unknown, opts?: LogOpts): void { ErrorLog._push('warn',  scope, msg, ctx, opts); },
  error(scope: string, msg: string, ctx?: unknown, opts?: LogOpts): void { ErrorLog._push('error', scope, msg, ctx, opts); },

  _pushRecent(level: LogLevel): void {
    const now = Date.now();
    ErrorLog._recent.push({ ts: now, level });
    while (ErrorLog._recent.length && ErrorLog._recent[0].ts < now - 60_000) ErrorLog._recent.shift();
  },
  errorRatePerMin(): number { return ErrorLog._recent.filter(e => e.level === 'error').length; },
  warnRatePerMin(): number  { return ErrorLog._recent.filter(e => e.level === 'warn').length; },

  installGlobalHandlers(): void {
    if (ErrorLog._globalsInstalled) return;
    ErrorLog._globalsInstalled = true;
    window.addEventListener('error', e => {
      const loc = e.filename ? `${e.filename}:${e.lineno || '?'}:${e.colno || '?'}` : '';
      ErrorLog.error('uncaught', `${e.message || 'Unknown error'}${loc ? ' @ ' + loc : ''}`, e.error?.stack);
    });
    window.addEventListener('unhandledrejection', e => {
      const reason = e.reason instanceof Error
        ? `${e.reason.message}\n${e.reason.stack || ''}`
        : String(e.reason);
      ErrorLog.error('promise', reason);
    });
  },

  entries(): LogEntry[] { return ErrorLog._entries.slice(); },
  countBy(level: LogLevel): number { return ErrorLog._entries.filter(e => e.level === level).length; },
  // Number of entries evicted past MAX since last clear (0 when none dropped).
  droppedCount(): number { return ErrorLog._droppedCount; },
  clear(): void {
    ErrorLog._entries = [];
    ErrorLog._recent = [];        // clear the rolling rate window so the badge clears immediately
    ErrorLog._droppedCount = 0;
    ErrorLog.renderBadge();
    ErrorLog._scheduleSave();
    for (const l of ErrorLog._listeners) { try { l({ cleared: true }); } catch {} }
  },
  subscribe(fn: (e: LogEntry | { cleared: true }) => void): () => void { ErrorLog._listeners.add(fn); return () => ErrorLog._listeners.delete(fn); },

  /* -----------------------------------------------------------------------
     DURABILITY — self-contained IndexedDB ring snapshot (own db/store, does
     NOT touch IntelDB which another module owns). Restored on boot, saved
     (debounced) on push. Fire-and-forget; never throws into a log push.
     ----------------------------------------------------------------------- */
  _DB_NAME:  'nimbus-errorlog',
  _DB_STORE: 'ring',
  _dbPromise: null as Promise<IDBDatabase | null> | null,
  _openDb(): Promise<IDBDatabase | null> {
    if (ErrorLog._dbPromise) return ErrorLog._dbPromise;
    ErrorLog._dbPromise = new Promise<IDBDatabase | null>((resolve, reject) => {
      try {
        if (typeof indexedDB === 'undefined') { resolve(null); return; }
        const req = indexedDB.open(ErrorLog._DB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(ErrorLog._DB_STORE)) db.createObjectStore(ErrorLog._DB_STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
      } catch (e) { reject(e); }
    }).catch(() => null);
    return ErrorLog._dbPromise;
  },
  _scheduleSave: Util.debounce(function () { ErrorLog._saveNow(); }, 800),
  _saveNow(): void {
    ErrorLog._openDb().then(db => {
      if (!db) return;
      try {
        const tx = db.transaction(ErrorLog._DB_STORE, 'readwrite');
        // Snapshot the tail (entries are already capped at MAX).
        tx.objectStore(ErrorLog._DB_STORE).put(ErrorLog._entries.slice(-ErrorLog.MAX), 'entries');
      } catch {}
    }).catch(() => {});
  },
  /** Restore persisted entries from a previous page load (prepended, capped). */
  restore(): Promise<void> {
    return ErrorLog._openDb().then(db => {
      if (!db) return;
      return new Promise<void>(resolve => {
        try {
          const tx  = db.transaction(ErrorLog._DB_STORE, 'readonly');
          const req = tx.objectStore(ErrorLog._DB_STORE).get('entries');
          req.onsuccess = () => {
            const prev = Array.isArray(req.result) ? req.result : [];
            if (prev.length) {
              ErrorLog._entries = prev.concat(ErrorLog._entries).slice(-ErrorLog.MAX);
              ErrorLog.renderBadge();
            }
            resolve();
          };
          req.onerror = () => resolve();
        } catch { resolve(); }
      });
    }).catch(() => {});
  },

  /* -----------------------------------------------------------------------
     SHIP — batch error-level entries to POST /logs/frontend, fire-and-forget,
     deduped by sessionId+reqId+ts, capped per batch (§1.6).
     ----------------------------------------------------------------------- */
  SHIP_BATCH_MAX: 50,
  _shipQueue: [] as LogEntry[],
  _shipSeen: new Set<string>(),
  _flushShip: Util.debounce(function () { ErrorLog._shipNow(); }, 1500),
  // Enqueue synchronously (dedupe), then debounce the actual network flush.
  _scheduleShip(e: LogEntry): void { ErrorLog._enqueueShip(e); ErrorLog._flushShip(); },
  _enqueueShip(e: LogEntry): void {
    const key = `${e.sessionId || ''}|${e.reqId || ''}|${e.ts}`;
    if (ErrorLog._shipSeen.has(key)) return;
    ErrorLog._shipSeen.add(key);
    if (ErrorLog._shipSeen.size > 2000) ErrorLog._shipSeen.clear(); // bound the dedupe set
    ErrorLog._shipQueue.push({
      ts: e.ts, level: e.level, scope: e.scope, msg: e.msg,
      errorCode: e.errorCode, reqId: e.reqId, stack: e.stack,
      buildId: e.buildId, sessionId: e.sessionId, plant: e.plant, route: e.route,
      ctx: e.ctx,
    });
  },
  _shipNow(): void {
    if (!ErrorLog._shipQueue.length) return;
    const batch = ErrorLog._shipQueue.splice(0, ErrorLog.SHIP_BATCH_MAX);
    try {
      // fire-and-forget; never block UI, swallow all failures (the entries are
      // still in the local ring + IndexedDB). Use bare fetch (not fetchTraced) so
      // a failed ship can't recursively enqueue another error-level entry.
      const url = `${Config.API_BASE}/logs/frontend`;
      if (typeof fetch === 'function') {
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ entries: batch }),
          keepalive: true,
        }).catch(() => {});
      }
    } catch {}
  },

  _safeCtx(v: unknown): unknown {
    try { JSON.stringify(v); return v; }
    catch { try { return String(v); } catch { return '[unserialisable]'; } }
  },

  // Debounced so rapid bursts of log pushes don't thrash the DOM. Guarded for
  // headless callers (Node unit tests import this module with no `document`
  // global) — real browser callers always have `document`, so this is a no-op
  // there.
  renderBadge: Util.debounce(function (): void {
    if (typeof document === 'undefined') return;
    if (!_adminGate()) {
      const existing = document.getElementById('err-log-btn');
      if (existing) existing.hidden = true;
      return;
    }
    let btn = document.getElementById('err-log-btn');
    if (!btn) {
      const host = document.getElementById('alert-bell')?.parentElement
                || document.querySelector('.topbar-actions')
                || document.body;
      btn = document.createElement('button');
      btn.id = 'err-log-btn';
      btn.className = 'icon-btn';
      btn.innerHTML = '<span class="log-ico" aria-hidden="true">🖥️</span>'
                     + '<span class="badge" id="err-log-badge" hidden>0</span>';
      btn.onclick = () => { try { _badgeClick(); } catch {} };
      host.appendChild(btn);
    }
    const tip = Util.t('tip.open_admin_log');
    btn.title = tip;
    btn.setAttribute('aria-label', tip);
    const sessionEntries = ErrorLog._entries.filter(e => e.sessionId === ErrorLog.SESSION_ID);
    const errs  = sessionEntries.filter(e => e.level === 'error').length;
    const warns = sessionEntries.filter(e => e.level === 'warn').length;
    const total = errs + warns;
    const badge = btn.querySelector<HTMLElement>('#err-log-badge')!;
    badge.hidden = total === 0;
    badge.textContent = String(total);
    badge.classList.toggle('warn', !errs && !!warns);
  }, 80),

  copy(): void {      const txt = ErrorLog._entries.map(e =>
      `${e.ts} [${e.level.toUpperCase()}] ${e.scope}: ${e.msg}${e.ctx ? ' :: ' + JSON.stringify(e.ctx) : ''}`
    ).join('\n');
    navigator.clipboard?.writeText(txt).then(
      () => Toast.show(Util.t('toast.log_copied'), 'success'),
      () => Toast.show(Util.t('toast.copy_failed'), 'error')
    );
  }
};

/* =============================================================================
   TOAST — transient notification banners (top-right stack).
     Toast.show(msg, type?, ms?)  — show a message; type: 'info'|'warn'|'error'|'success'
     Cap of 3 visible at once: drops oldest non-error first when exceeded.
     Dedupes by (msg, type) — repeats refresh the existing toast's timer.
     Default duration 1500ms; callers may override.
   ========================================================================== */
export const Toast = (function() {
  const MAX_VISIBLE = 3;
  const _visible: ToastEntry[] = [];

  function _scheduleRemoval(entry: ToastEntry, ms: number): void {
    entry.timerId = setTimeout(() => _remove(entry), ms);
  }

  function _remove(entry: ToastEntry): void {
    if (entry._removing) return;
    entry._removing = true;
    if (entry.timerId) { clearTimeout(entry.timerId); entry.timerId = null; }
    const idx = _visible.indexOf(entry);
    if (idx !== -1) _visible.splice(idx, 1);
    entry.el.classList.add('leaving');
    setTimeout(() => entry.el.remove(), Config.ANIM_MS);
  }

  function _evictOne(): void {
    let victim = _visible.find(e => e.type !== 'error');
    if (!victim) victim = _visible[0];
    if (victim) _remove(victim);
  }

  return {
    show(msg: string, type: string = 'info', ms: number = 1500): void {
      const stack = document.getElementById('toast-stack');
      if (!stack) return;

      const dup = _visible.find(e => !e._removing && e.msg === msg && e.type === type);
      if (dup) {
        if (dup.timerId) clearTimeout(dup.timerId);
        _scheduleRemoval(dup, ms);
        return;
      }

      while (_visible.length >= MAX_VISIBLE) _evictOne();

      const el = document.createElement('div');
      el.className = `toast ${type}`;
      el.textContent = msg;
      stack.appendChild(el);

      const entry = { el, msg, type, timerId: null, _removing: false };
      _visible.push(entry);
      _scheduleRemoval(entry, ms);
    }
  };
})();

/* =============================================================================
   MODAL — show/hide helpers for all modals (driven by hidden attribute).
     Modal.open(id)                  — unhide modal with the given element ID
     Modal.close(id)                 — hide modal with the given element ID
     Modal.confirm(msg, onOk, onCancel?) — two-button confirmation dialog
   ========================================================================== */
export const Modal = {
  open(id: string): void  { const el = document.getElementById(id); if (el) el.hidden = false; },
  close(id: string): void { const el = document.getElementById(id); if (el) el.hidden = true;  },

  // Promise-based confirmation dialog.
  // opts: { title, message, detail (HTML string), confirmLabel, tone: 'danger'|'warn' }
  confirm(opts: ModalConfirmOpts = {}): Promise<boolean> {
    return new Promise(resolve => {
      document.getElementById('confirm-title')!.textContent   = opts.title   || 'Confirm';
      document.getElementById('confirm-message')!.textContent = opts.message || '';
      const det = document.getElementById('confirm-detail')!;
      if (opts.detail) { det.innerHTML = opts.detail; det.hidden = false; }
      else             { det.textContent = ''; det.hidden = true; }
      const okBtn = document.getElementById('confirm-ok-btn')!;
      okBtn.textContent  = opts.confirmLabel || 'Confirm';
      okBtn.className    = `btn btn-${opts.tone === 'warn' ? 'warn' : 'danger'}`;
      const closeBtn = document.getElementById('confirm-close-btn')!;
      const done = (ok: boolean): void => { cleanup(); resolve(ok); };
      const cleanup = (): void => {
        okBtn.removeEventListener('click', onOk);
        document.getElementById('confirm-cancel-btn')!.removeEventListener('click', onCancel);
        closeBtn.removeEventListener('click', onCancel);
        Modal.close('confirm-modal');
      };
      const onOk     = (): void => done(true);
      const onCancel = (): void => done(false);
      okBtn.addEventListener('click', onOk);
      document.getElementById('confirm-cancel-btn')!.addEventListener('click', onCancel);
      closeBtn.addEventListener('click', onCancel);
      Modal.open('confirm-modal');
    });
  }
};
