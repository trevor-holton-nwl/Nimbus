// toast-log-tab.mts - the "Toast Log" tab of the alerts drawer (#alert-drawer). Lists every toast the planner
// has seen (ErrorLog scope 'toast', newest first, with the time it fired) and downloads the log as JSON.
// The Alerts tab, the bell badge and AlertsUIAdapter.renderDrawer are untouched: the badge still counts alerts only.
// Wiring is addEventListener from init() (no inline on*= handlers: legacy-surface ratchet). init() is called from
// Dashboard.init() (insights-ui.mts), which app.js runs at _bootMain.
import { Util, ErrorLog, Toast } from '../platform/foundation.mjs';
type LogEntry = ReturnType<typeof ErrorLog.entries>[number];

const ICONS: Record<string, string> = { error: '✖', warn: '⚠', info: 'ℹ', success: '✓' };
const SEV: Record<string, string> = { error: 'err', warn: 'warn', info: 'info', success: 'ok' };
const DEBOUNCE_MS = 100;

let _tab: 'alerts' | 'toasts' = 'alerts';
let _timer: ReturnType<typeof setTimeout> | null = null;
let _boundTo: HTMLElement | null = null;   // idempotent init: a second Dashboard.init() must not rebind

const $ = (id: string): HTMLElement | null => document.getElementById(id);

export const ToastLogTab = {
  init(): void {
    const nav = $('alert-drawer-tabs');
    if (nav && _boundTo === nav) return;
    _boundTo = nav;
    $('alert-drawer-tabs')?.addEventListener('click', (e: Event) => {
      const btn = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-drawer-tab]');
      const tab = btn?.dataset.drawerTab;
      if (tab === 'alerts' || tab === 'toasts') ToastLogTab.activate(tab);
    });
    $('toast-log-export')?.addEventListener('click', () => {
      ErrorLog.exportJson();
      Toast.show(Util.t('toast.log_exported'), 'success');
    });
    $('alert-drawer-tabs')?.addEventListener('keydown', (e: Event) => {
      const k = (e as KeyboardEvent).key;
      if (k !== 'ArrowLeft' && k !== 'ArrowRight') return;
      e.preventDefault();
      const next = _tab === 'alerts' ? 'toasts' : 'alerts';
      ToastLogTab.activate(next);
      $('alert-tab-' + next)?.focus();
    });
    ErrorLog.subscribe(ToastLogTab._onLog);
  },

  activate(tab: 'alerts' | 'toasts'): void {
    const toasts = tab === 'toasts';
    // The alerts footer is hidden under the Toast Log tab by the [data-drawer-tab] CSS rule, never by JS state,
    // so renderDrawer's own footer.hidden stays authoritative across tab switches.
    ToastLogTab._clearTimer();
    _tab = tab;
    const body = $('alert-drawer-body');
    const dismiss = $('alert-dismiss-visible');
    if (body) body.hidden = toasts;
    if (dismiss) dismiss.hidden = toasts;
    const tb = $('toast-log-body');
    const tf = $('toast-log-footer');
    if (tb) tb.hidden = !toasts;
    if (tf) tf.hidden = !toasts;
    $('alert-drawer')?.setAttribute('data-drawer-tab', tab);
    document.querySelectorAll<HTMLElement>('#alert-drawer-tabs [data-drawer-tab]').forEach(b => {
      const on = b.dataset.drawerTab === tab;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
      b.setAttribute('tabindex', on ? '0' : '-1');
    });
    if (toasts) ToastLogTab.render();
  },

  render(): void {
    const el = $('toast-log-body');
    if (!el) return;
    const rows = ErrorLog.entries().filter((e: LogEntry) => e.scope === 'toast').reverse();
    if (!rows.length) {
      el.innerHTML = `<div class="empty-state" style="padding:24px;color:var(--fg-mute);">${Util.escapeHtml(Util.t('empty.no_toasts'))}</div>`;
      return;
    }
    el.innerHTML = rows.map((e: LogEntry) => {
      const type = String((e.ctx as { type?: string } | undefined)?.type || 'info');
      return `<div class="alert-row toast-row toast-${SEV[type] || 'info'}">` +
        `<span class="alert-ico">${ICONS[type] || 'ℹ'}</span>` +
        `<span class="alert-msg">${Util.escapeHtml(e.msg)}</span>` +
        `<span class="alert-time">${Util.escapeHtml(Util.fmtDTReadable(e.ts))}</span></div>`;
    }).join('');
  },

  /** ErrorLog subscriber: re-render (debounced) only while the drawer is open on the Toast Log tab. */
  _clearTimer(): void { if (_timer) { clearTimeout(_timer); _timer = null; } },

  _onLog(): void {
    if (_tab !== 'toasts' || !$('alert-drawer')?.classList.contains('open')) { ToastLogTab._clearTimer(); return; }
    if (_timer) clearTimeout(_timer);
    _timer = setTimeout(() => {
      _timer = null;
      if (_tab === 'toasts' && $('alert-drawer')?.classList.contains('open')) ToastLogTab.render();   // drawer may have closed meanwhile
    }, DEBOUNCE_MS);
  },
};
