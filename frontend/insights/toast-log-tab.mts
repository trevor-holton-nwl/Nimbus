// toast-log-tab.mts - the "Toast Log" tab of the alerts drawer (#alert-drawer). Lists every toast the planner
// has seen (ErrorLog scope 'toast', newest first, with the time it fired) and downloads the log as JSON.
// The Alerts tab, the bell badge and AlertsUIAdapter.renderDrawer are untouched: the badge still counts alerts only.
// Wiring is addEventListener from init() (no inline on*= handlers: legacy-surface ratchet). init() is called from
// Dashboard.init() (insights-ui.mts), which app.js runs at _bootMain.
import { Util, ErrorLog, Toast } from '../platform/foundation.mjs';
type LogEntry = ReturnType<typeof ErrorLog.entries>[number];

const ICONS: Record<string, string> = { error: '✖', warn: '⚠', info: 'ℹ', success: '✓' };
const SEV: Record<string, string> = { error: 'err', warn: 'warn', info: 'info' };
const DEBOUNCE_MS = 100;

let _tab: 'alerts' | 'toasts' = 'alerts';
let _timer: ReturnType<typeof setTimeout> | null = null;
let _footerWasHidden = true;

const $ = (id: string): HTMLElement | null => document.getElementById(id);

export const ToastLogTab = {
  init(): void {
    $('alert-drawer-tabs')?.addEventListener('click', (e: Event) => {
      const btn = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-drawer-tab]');
      const tab = btn?.dataset.drawerTab;
      if (tab === 'alerts' || tab === 'toasts') ToastLogTab.activate(tab);
    });
    $('toast-log-export')?.addEventListener('click', () => {
      ErrorLog.exportJson();
      Toast.show(Util.t('toast.log_exported'), 'success');
    });
    ErrorLog.subscribe(ToastLogTab._onLog);
  },

  activate(tab: 'alerts' | 'toasts'): void {
    const toasts = tab === 'toasts';
    const footer = $('alert-drawer-footer');
    if (toasts && _tab !== 'toasts' && footer) _footerWasHidden = footer.hidden;
    _tab = tab;
    const body = $('alert-drawer-body');
    const dismiss = $('alert-dismiss-visible');
    if (body) body.hidden = toasts;
    if (dismiss) dismiss.hidden = toasts;
    if (footer) footer.hidden = toasts ? true : _footerWasHidden;
    const tb = $('toast-log-body');
    const tf = $('toast-log-footer');
    if (tb) tb.hidden = !toasts;
    if (tf) tf.hidden = !toasts;
    $('alert-drawer')?.setAttribute('data-drawer-tab', tab);
    document.querySelectorAll<HTMLElement>('#alert-drawer-tabs [data-drawer-tab]').forEach(b => {
      const on = b.dataset.drawerTab === tab;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
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
      return `<div class="alert-row alert-${SEV[type] || 'info'}">` +
        `<span class="alert-ico">${ICONS[type] || 'ℹ'}</span>` +
        `<span class="alert-msg">${Util.escapeHtml(e.msg)}</span>` +
        `<span class="alert-time">${Util.escapeHtml(Util.fmtDTReadable(e.ts))}</span></div>`;
    }).join('');
  },

  /** ErrorLog subscriber: re-render (debounced) only while the drawer is open on the Toast Log tab. */
  _onLog(): void {
    if (_tab !== 'toasts' || !$('alert-drawer')?.classList.contains('open')) return;
    if (_timer) clearTimeout(_timer);
    _timer = setTimeout(() => { _timer = null; ToastLogTab.render(); }, DEBOUNCE_MS);
  },
};
