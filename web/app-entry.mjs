// app-entry.mjs — CQ-1 temporary ESM entry point.
//
// Statically imports the extracted foundation module, bridges its exports
// onto `window.__NIMBUS_FOUNDATION`, then loads the still-legacy app.js and
// nimbus-intelligence.js as classic scripts, in that strict order. Once both
// have loaded, the bridge is deleted from `window` again (see bootEntry) — it
// exists only to hand off values across the classic-script boundary, not as a
// permanent global. This file shrinks over Phase 2-4 as more of app.js's
// content moves into real modules, and disappears once app.js does.
import * as foundation from './application-foundation.mjs';
import * as state from './schedule-state.mjs';
import * as services from './schedule-services.mjs';
import * as data from './schedule-data.mjs';

export function bootEntry({ window: win = (typeof window !== 'undefined' ? window : undefined), loadScript } = {}) {
  if (!win) return Promise.reject(new Error('NIMBUS boot error: no window available for bootEntry'));
  win.__NIMBUS_FOUNDATION = foundation;
  win.__NIMBUS_STATE = state;
  win.__NIMBUS_SERVICES = services;
  win.__NIMBUS_DATA = data;

  const inject = loadScript || defaultLoadScript;
  const v = win.NIMBUS_BUILD_ID || 'dev';

  return inject(`app.js?v=${encodeURIComponent(v)}`)
    .catch(e => { throw new Error(`NIMBUS boot error: failed to load app.js — ${e.message}`); })
    .then(() => inject(`nimbus-intelligence.js?v=${encodeURIComponent(v)}`)
      .catch(e => { throw new Error(`NIMBUS boot error: failed to load nimbus-intelligence.js — ${e.message}`); }))
    .then(() => {
      // Both classic scripts have now finished executing. app.js destructures
      // everything it needs from these bridges synchronously at the top of its
      // own IIFE, and nimbus-intelligence.js never reads them at all — so the
      // bridge has served its purpose. Delete it rather than leaving it as a
      // permanent, enumerable `window` property: some of what it carries
      // (e.g. PerfMonitor, VirtualList) was never part of the public NIMBUS
      // namespace pre-migration and was reachable only to code sharing the
      // classic-script lexical scope, not to arbitrary window-scoped code.
      delete win.__NIMBUS_FOUNDATION;
      delete win.__NIMBUS_STATE;
      delete win.__NIMBUS_SERVICES;
      delete win.__NIMBUS_DATA;
    });
}

function defaultLoadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(`script failed to load: ${src}`));
    document.head.appendChild(el);
  });
}

// Cache-bust redirect guard. Moved here from the top of web/app.js: under the
// pre-CQ-1 `document.write('<script src="app.js">')` load, this ran mid-parse,
// almost immediately. Now that app.js is fetched by a dynamically-created
// <script> from inside bootEntry() (itself only reached after this deferred
// `type="module"` entry point runs, post-full-parse), running the guard at the
// top of app.js would fire it much later — after this file, its static
// imports, and app.js's own network fetch have all completed. Running it here
// instead, before app.js is even requested, recovers most of that gap. Reuses
// `NIMBUS_BUILD_ID` (already the single source of truth for the app.js /
// nimbus-intelligence.js / locale `?v=` cache-busting query params — see
// index.html) instead of tracking a second, separately-bumped version
// constant the way the old app.js guard's `APP_VERSION` did.
export function runCacheBustGuard(win) {
  const KEY = 'nimbus.app.ver';
  const version = win.NIMBUS_BUILD_ID || 'dev';
  let stored;
  try { stored = win.sessionStorage.getItem(KEY); }
  catch { return; } // sessionStorage can throw (e.g. privacy mode) — never block boot on it
  if (stored === version) return;
  try {
    win.sessionStorage.setItem(KEY, version);
    const base = win.location.pathname + win.location.search.replace(/[?&]_v=[^&]*/g, '');
    const sep = base.includes('?') ? '&' : '?';
    win.location.replace(base + sep + '_v=' + version);
  } catch { /* never block boot on a storage/location failure */ }
}

// Auto-boot when this module is the page's real entry point. Under a plain
// Node `import()` (as in tests), `window` is undefined, so this never fires —
// tests call `bootEntry({ window, loadScript })` explicitly instead.
if (typeof window !== 'undefined' && window.document) {
  runCacheBustGuard(window);
  bootEntry().catch(e => {
    console.error('[NIMBUS boot]', e);
    const banner = document.createElement('div');
    banner.className = 'nimbus-boot-error-banner';
    banner.textContent = `NIMBUS failed to load: ${(e && e.message) || e}`;
    document.body.insertBefore(banner, document.body.firstChild);
  });
}
