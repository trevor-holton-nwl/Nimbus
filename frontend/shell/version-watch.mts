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
  Toast: { show(msg: string, type?: string, ms?: number, action?: { label: string; run: () => void }): void };
  Util: { t(key: string): string };
  Persistence: { hasPendingWork(): boolean };
  Modal: { confirm(opts: { title?: string; message?: string; confirmLabel?: string }): Promise<boolean> };
  reload?: () => void;
}

/* PLACEHOLDER presenter: an info Toast with a Refresh action. The final banner
   look replaces this factory (the seam is the onNewVersion callback passed to
   startVersionWatch); the pending-work confirm path in `run` is the contract to keep. */
export function makeUpdatePresenter(deps: PresenterDeps): (remoteId: string) => void {
  const { Toast, Util, Persistence, Modal } = deps;
  const reload = deps.reload ?? (() => location.reload());
  const run = async (): Promise<void> => {
    if (Persistence.hasPendingWork()) {
      const ok = await Modal.confirm({
        title: Util.t('toast.update_available'),
        message: Util.t('confirm.update_unsaved'),
        confirmLabel: Util.t('toast.update_refresh'),
      });
      if (!ok) return;
    }
    reload();
  };
  return () => {
    Toast.show(Util.t('toast.update_available'), 'info', 30 * 60 * 1000,
      { label: Util.t('toast.update_refresh'), run: () => { void run(); } });
  };
}
