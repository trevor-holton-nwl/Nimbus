// app-entry.mjs — CQ-1 temporary ESM entry point.
//
// Statically imports the extracted foundation module, bridges its exports
// onto `window.__NIMBUS_FOUNDATION`, then loads the still-legacy app.js and
// nimbus-intelligence.js as classic scripts, in that strict order. This file
// shrinks over Phase 2-4 as more of app.js's content moves into real modules,
// and disappears once app.js does.
import * as foundation from './application-foundation.mjs';

export function bootEntry({ window: win = (typeof window !== 'undefined' ? window : undefined), loadScript } = {}) {
  if (!win) return Promise.reject(new Error('NIMBUS boot error: no window available for bootEntry'));
  win.__NIMBUS_FOUNDATION = foundation;

  const inject = loadScript || defaultLoadScript;
  const v = win.NIMBUS_BUILD_ID || 'dev';

  return inject(`app.js?v=${encodeURIComponent(v)}`)
    .catch(e => { throw new Error(`NIMBUS boot error: failed to load app.js — ${e.message}`); })
    .then(() => inject(`nimbus-intelligence.js?v=${encodeURIComponent(v)}`)
      .catch(e => { throw new Error(`NIMBUS boot error: failed to load nimbus-intelligence.js — ${e.message}`); }));
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

// Auto-boot when this module is the page's real entry point. Under a plain
// Node `import()` (as in tests), `window` is undefined, so this never fires —
// tests call `bootEntry({ window, loadScript })` explicitly instead.
if (typeof window !== 'undefined' && window.document) {
  bootEntry().catch(e => {
    console.error('[NIMBUS boot]', e);
    document.body.insertAdjacentHTML('afterbegin',
      `<div style="background:#c0392b;color:#fff;padding:12px;font:14px monospace;">NIMBUS failed to load: ${(e && e.message) || e}</div>`);
  });
}
