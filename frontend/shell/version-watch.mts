/* ═══════════════════════════════════════════════════════════
   VERSION WATCH — tells an open tab that a newer build is live
   Polls GET /version (the build id stamped into index.html) and calls
   onNewVersion when it differs from this tab's window.NIMBUS_BUILD_ID.
   Never reloads on its own; the presenter decides how to ask the user.
   ═══════════════════════════════════════════════════════════ */

export function shouldNotify(current: unknown, remote: unknown): boolean {
  return typeof current === 'string' && current !== ''
    && typeof remote === 'string' && remote !== ''
    && current !== remote;
}

interface WatchDoc {
  hidden: boolean;
  addEventListener(type: 'visibilitychange', fn: () => void): void;
  removeEventListener(type: 'visibilitychange', fn: () => void): void;
}

export interface VersionWatchOptions {
  fetchVersion?: () => Promise<string | null | undefined>;
  intervalMs?: number;
  currentId?: string;
  onNewVersion: (remoteId: string) => void;
  doc?: WatchDoc;
  win?: { NIMBUS_BUILD_ID?: string };
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}

async function defaultFetchVersion(): Promise<string | null> {
  // Plain fetch on purpose: fetchTraced would log an ErrorLog error on every failed tick.
  // eslint-disable-next-line no-restricted-globals
  const res = await fetch('/version', { cache: 'no-store', signal: AbortSignal.timeout(6000) });
  if (!res.ok) return null;
  const body = await res.json() as { build_id?: string | null };
  return body.build_id ?? null;
}

export function startVersionWatch(opts: VersionWatchOptions): () => void {
  const fetchVersion = opts.fetchVersion ?? defaultFetchVersion;
  const intervalMs = opts.intervalMs ?? 300000;
  const doc = opts.doc ?? ((globalThis as unknown as { document: WatchDoc }).document);
  const win = opts.win ?? (globalThis as unknown as { NIMBUS_BUILD_ID?: string });
  const setTimer = opts.setIntervalFn ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clearTimer = opts.clearIntervalFn ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));
  let inFlight = false;
  let stopped = false;

  async function check(): Promise<void> {
    if (inFlight || stopped) return;
    inFlight = true;
    try {
      const remote = await fetchVersion();
      const current = opts.currentId ?? win.NIMBUS_BUILD_ID;
      if (!stopped && shouldNotify(current, remote)) opts.onNewVersion(remote as string);
    } catch {
      // A failed poll is silent by design; the next tick tries again.
    } finally {
      inFlight = false;
    }
  }

  const onVisibility = (): void => { if (!doc.hidden) void check(); };
  doc.addEventListener('visibilitychange', onVisibility);
  const timer = setTimer(() => { if (!doc.hidden) void check(); }, intervalMs);

  return function stop(): void {
    stopped = true;
    clearTimer(timer);
    doc.removeEventListener('visibilitychange', onVisibility);
  };
}

interface PresenterDeps {
  Util: { t(key: string): string };
  Persistence: { hasPendingWork(includeStored?: boolean): boolean };
  Modal: { confirm(opts: { title?: string; message?: string; confirmLabel?: string }): Promise<boolean> };
  reload?: () => void;
  doc?: Document;                // test seam, defaults to `document`
  onLayoutChange?: () => void;   // the shell redraws the Gantt after the strip toggles (version-watch must not import it)
}

/* The "new version available" banner: one in-flow strip (#update-banner in index.html, translated by the
   boot i18n sweep) shown through `hidden` + body.update-available. Presenter state lives in this closure only.
   The watcher calls the presenter on every poll while the ids differ, so it is idempotent per id; showing
   never moves focus and nothing here reloads without the planner pressing Refresh (the pending-work confirm
   path in `run` is the contract to keep). */
export function makeUpdatePresenter(deps: PresenterDeps): (remoteId: string) => void {
  const { Util, Persistence, Modal } = deps;
  const doc = deps.doc ?? document;
  const reload = deps.reload ?? (() => location.reload());
  let el: HTMLElement | null = null;
  let shownId: string | null = null;
  let lastDismissedId: string | null = null;
  let refreshBusy = false;

  const run = async (): Promise<void> => {
    if (refreshBusy) return;
    refreshBusy = true;
    try {
      if (Persistence.hasPendingWork(false)) {
        const ok = await Modal.confirm({
          title: Util.t('toast.update_available'),
          message: Util.t('confirm.update_unsaved'),
          confirmLabel: Util.t('toast.update_refresh'),
        });
        if (!ok) return;
      }
      reload();
    } finally {
      refreshBusy = false;
    }
  };

  // Same markup as index.html, for a page that lacks the static element (test harness, future layout).
  function build(): HTMLElement {
    const node = doc.createElement('div');
    node.id = 'update-banner';
    node.className = 'update-banner';
    node.setAttribute('role', 'status');
    node.setAttribute('aria-live', 'polite');
    node.hidden = true;
    const ico = doc.createElement('span');
    ico.className = 'update-banner-ico';
    ico.setAttribute('aria-hidden', 'true');
    ico.textContent = '↻';
    const msg = doc.createElement('span');
    msg.className = 'update-banner-msg';
    msg.textContent = Util.t('toast.update_available');
    msg.title = Util.t('toast.update_available');
    const tag = doc.createElement('span');
    tag.className = 'update-banner-build';
    tag.id = 'update-banner-build';
    tag.setAttribute('aria-hidden', 'true');
    const actions = doc.createElement('span');
    actions.className = 'update-banner-actions';
    const refresh = doc.createElement('button');
    refresh.type = 'button';
    refresh.className = 'btn btn-primary sm update-banner-refresh';
    refresh.id = 'update-banner-refresh';
    refresh.textContent = Util.t('toast.update_refresh');
    const dismissBtn = doc.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.className = 'icon-btn sm update-banner-dismiss';
    dismissBtn.id = 'update-banner-dismiss';
    dismissBtn.setAttribute('aria-label', Util.t('btn.dismiss'));
    dismissBtn.title = Util.t('btn.dismiss');
    dismissBtn.textContent = '×';
    actions.append(refresh, dismissBtn);
    node.append(ico, msg, tag, actions);
    const bar = doc.querySelector('.context-bar');
    if (bar) bar.after(node);
    else doc.body.prepend(node);
    return node;
  }

  function ensure(): HTMLElement {
    if (el?.isConnected) return el;
    el = doc.getElementById('update-banner') ?? build();
    if (!el.dataset.wired) {
      el.querySelector('#update-banner-refresh')?.addEventListener('click', () => { void run(); });
      el.querySelector('#update-banner-dismiss')?.addEventListener('click', dismiss);
      el.dataset.wired = '1';
    }
    return el;
  }

  function show(remoteId: string): void {
    const node = ensure();
    const tag = node.querySelector('#update-banner-build');
    if (tag) tag.textContent = remoteId;
    const wasHidden = node.hidden;
    node.hidden = false;
    doc.body.classList.add('update-available');
    shownId = remoteId;
    if (wasHidden) deps.onLayoutChange?.();
  }

  function hide(): void {
    if (!el) return;
    const hadFocus = el.contains(doc.activeElement);
    el.hidden = true;
    doc.body.classList.remove('update-available');
    shownId = null;
    if (hadFocus) doc.getElementById('nav-drawer-toggle')?.focus({ preventScroll: true });
    deps.onLayoutChange?.();
  }

  function dismiss(): void {
    lastDismissedId = shownId;
    hide();
  }

  return function onNewVersion(remoteId: string): void {
    if (!remoteId) return;
    if (remoteId === lastDismissedId) return;
    if (shownId === remoteId && el && !el.hidden) return;
    show(remoteId);
  };
}
