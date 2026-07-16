// application-foundation.mjs — CQ-1 foundation module.
// Owns immutable configuration, generic UI chrome (Toast/Modal), the perf
// profiler, and the virtual-list windowing helper. No schedule state, no
// feature endpoints, no scheduling rules. See docs/architecture/
// cq1-compatibility-inventory.md for the full module ownership map.

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
  SCHEMA_VERSION:     4,                          // bump whenever _saveCache snapshot fields change
  BUILD_ID:           (typeof window !== 'undefined' && window.NIMBUS_BUILD_ID) || 'dev',
  DEFAULT_PLANT:      null,
  KNOWN_PLANTS:       ['5512', '1006'],
  CENTER_ON_CLICK:    true,                       // set false to disable click-to-center in Gantt
  DEBUG_BLOCKS:       true,                       // when true, Store.addBlock/addPlantBlock console.trace every push (for diagnosing duplicate-add bugs)
  CONCURRENCY_CHECK:  true                         // optimistic-concurrency guard on task writes. Set false to force every write (legacy last-write-wins) if the guard misbehaves in a multi-user pilot.
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
export class VirtualList {
  constructor(scrollEl, { rowH, getRowH, renderFn, mountEl, buffer = 5 } = {}) {
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
    this._onScroll = () => this._paint();
    scrollEl.addEventListener('scroll', this._onScroll, { passive: true });
  }

  update(items) {
    this._items = items;
    if (this._getRowH) {
      const n = items.length;
      this._offsets = new Float64Array(n + 1);
      for (let i = 0; i < n; i++) {
        this._offsets[i + 1] = this._offsets[i] + this._getRowH(items[i]);
      }
    }
    this._paint();
  }

  _totalH() {
    if (this._fixedH !== null) return this._items.length * this._fixedH;
    return this._offsets ? this._offsets[this._items.length] : 0;
  }

  _offsetOf(i) {
    if (this._fixedH !== null) return i * this._fixedH;
    return this._offsets ? this._offsets[i] : 0;
  }

  _paint() {
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
    let lo, hi;

    if (this._fixedH !== null) {
      lo = Math.max(0, Math.floor(scrollTop / this._fixedH) - buf);
      hi = Math.min(n, Math.ceil((scrollTop + viewH) / this._fixedH) + buf);
    } else {
      // Binary search for first item whose bottom edge is below scrollTop
      let l = 0, r = n - 1;
      while (l < r) {
        const m = (l + r) >> 1;
        if (this._offsets[m + 1] <= scrollTop) l = m + 1; else r = m;
      }
      lo = Math.max(0, l - buf);
      // Walk forward until item top exceeds viewport bottom
      let e = lo;
      while (e < n && this._offsets[e] < scrollTop + viewH) e++;
      hi = Math.min(n, e + buf);
    }

    this._inner.style.paddingTop    = this._offsetOf(lo) + 'px';
    this._inner.style.paddingBottom = (this._totalH() - this._offsetOf(hi)) + 'px';

    let html = '';
    for (let i = lo; i < hi; i++) html += this._renderFn(this._items[i], i);
    this._inner.innerHTML = html;
  }

  destroy() {
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
  const _buckets = new Map(); // name → { buf: Float32Array, head, count, last, lastTs }
  const _listeners = new Set();
  let _notifyTimer = null;

  function record(name, ms) {
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

  function time(name, fn) {
    const t = performance.now();
    const r = fn();
    record(name, performance.now() - t);
    return r;
  }

  function stats(name) {
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

  function all() {
    return [..._buckets.keys()].map(k => ({ name: k, ...stats(k) }));
  }

  function clear() { _buckets.clear(); _notify(); }
  function subscribe(fn) { _listeners.add(fn); }

  function _notify() {
    if (_notifyTimer) return;
    _notifyTimer = setTimeout(() => { _notifyTimer = null; _listeners.forEach(fn => fn()); }, 250);
  }

  return { record, time, stats, all, clear, subscribe };
})();

/* =============================================================================
   TOAST — transient notification banners (top-right stack).
     Toast.show(msg, type?, ms?)  — show a message; type: 'info'|'warn'|'error'|'success'
     Cap of 3 visible at once: drops oldest non-error first when exceeded.
     Dedupes by (msg, type) — repeats refresh the existing toast's timer.
     Default duration 1500ms; callers may override.
   ========================================================================== */
export const Toast = (function() {
  const MAX_VISIBLE = 3;
  const _visible = [];

  function _scheduleRemoval(entry, ms) {
    entry.timerId = setTimeout(() => _remove(entry), ms);
  }

  function _remove(entry) {
    if (entry._removing) return;
    entry._removing = true;
    if (entry.timerId) { clearTimeout(entry.timerId); entry.timerId = null; }
    const idx = _visible.indexOf(entry);
    if (idx !== -1) _visible.splice(idx, 1);
    entry.el.classList.add('leaving');
    setTimeout(() => entry.el.remove(), Config.ANIM_MS);
  }

  function _evictOne() {
    let victim = _visible.find(e => e.type !== 'error');
    if (!victim) victim = _visible[0];
    if (victim) _remove(victim);
  }

  return {
    show(msg, type = 'info', ms = 1500) {
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
  open(id)  { const el = document.getElementById(id); if (el) el.hidden = false; },
  close(id) { const el = document.getElementById(id); if (el) el.hidden = true;  },

  // Promise-based confirmation dialog.
  // opts: { title, message, detail (HTML string), confirmLabel, tone: 'danger'|'warn' }
  confirm(opts = {}) {
    return new Promise(resolve => {
      document.getElementById('confirm-title').textContent   = opts.title   || 'Confirm';
      document.getElementById('confirm-message').textContent = opts.message || '';
      const det = document.getElementById('confirm-detail');
      if (opts.detail) { det.innerHTML = opts.detail; det.hidden = false; }
      else             { det.textContent = ''; det.hidden = true; }
      const okBtn = document.getElementById('confirm-ok-btn');
      okBtn.textContent  = opts.confirmLabel || 'Confirm';
      okBtn.className    = `btn btn-${opts.tone === 'warn' ? 'warn' : 'danger'}`;
      const closeBtn = document.getElementById('confirm-close-btn');
      const done = ok => { cleanup(); resolve(ok); };
      const cleanup = () => {
        okBtn.removeEventListener('click', onOk);
        document.getElementById('confirm-cancel-btn').removeEventListener('click', onCancel);
        closeBtn.removeEventListener('click', onCancel);
        Modal.close('confirm-modal');
      };
      const onOk     = () => done(true);
      const onCancel = () => done(false);
      okBtn.addEventListener('click', onOk);
      document.getElementById('confirm-cancel-btn').addEventListener('click', onCancel);
      closeBtn.addEventListener('click', onCancel);
      Modal.open('confirm-modal');
    });
  }
};
