/* =============================================================================
   N.I.M.B.U.S. Intelligence Layer  (nimbus-intelligence.js)
   Loaded after app.js — extends window.NIMBUS with 14 intelligence modules.

   Modules:
     CommandPalette  — Cmd+K fuzzy search overlay
     TimeMachine     — IndexedDB-backed history scrubber
     Confidence      — live 0-100 schedule health score + sparkline
     (Alert cells are now native vis-timeline background items — see app.js)
     RipplePreview   — Alt-hover downstream-shift preview
     Diff            — snapshot diff viewer
     Patterns        — sequence-pair learning from drags
   ============================================================================= */
(function () {
  'use strict';

  // app.js uses `const NIMBUS = ...` — a block-scoped global, not window.NIMBUS.
  // Access it directly by name (resolved at call time through the scope chain).
  if (typeof NIMBUS === 'undefined' || !NIMBUS.Store) {
    // Boot guard: NIMBUS itself is missing, so ErrorLog almost certainly isn't
    // available either — guard anyway and fall back to console.
    (window.NIMBUS && window.NIMBUS.ErrorLog
      ? window.NIMBUS.ErrorLog.warn('intel', 'app.js must load first.', { errorCode: 'internal' })
      : console.error('[NIMBUS.Intelligence] app.js must load first.'));
    return;
  }

  const { Store, Toast, Alerts, AlertsUIAdapter, Util, UndoStack, Utilization } = NIMBUS;

  /* --- CSS injection ------------------------------------------------------- */
  (function _injectStyles() {
    const s = document.createElement('style');
    s.id = 'ni-styles';
    s.textContent = `
/* ── Command Palette FAB ───────────────────────────────── */
#ni-cmd-fab {
  position:fixed; bottom:24px; right:24px; z-index:9990;
  width:45px; height:45px; border-radius:50%;
  background:var(--primary); color:#fff; border:none; cursor:pointer;
  font-size:18px; display:flex; align-items:center; justify-content:center;
  box-shadow:0 4px 16px rgba(26,27,31,0.3),0 1px 4px rgba(26,27,31,0.12);
  transition:transform 200ms ease,box-shadow 200ms ease,background 200ms ease;
}
#ni-cmd-fab:hover {
  transform:scale(1.09);
  box-shadow:0 6px 24px rgba(26,27,31,0.38),0 2px 6px rgba(26,27,31,0.15);
  background:var(--primary-hot);
}
#ni-cmd-fab.ni-fab-locked {
  opacity:0.32; cursor:not-allowed; filter:grayscale(0.6);
}
#ni-cmd-fab.ni-fab-locked:hover { transform:none; box-shadow:0 4px 16px rgba(26,27,31,0.3),0 1px 4px rgba(26,27,31,0.12); background:var(--primary); }
#ni-cmd-fab.ni-fab-locked::after { content:'Select a plant to unlock'; }
#ni-cmd-fab.ni-fab-active {
  background:var(--accent);
  box-shadow:0 4px 20px rgba(var(--accent-rgb,31,95,191),0.45);
}
#ni-cmd-fab::after {
  content:'ctrl + k';
  position:absolute; right:68px; bottom:50%; transform:translateY(50%);
  background:var(--primary); color:var(--primary-fg);
  font-size:11px; font-weight:600; padding:5px 12px;
  border-radius:8px; white-space:nowrap;
  opacity:0; pointer-events:none;
  transition:opacity 150ms 80ms;
  box-shadow:var(--shadow-md);
}
#ni-cmd-fab:hover::after { opacity:1; }

/* ── Command Palette Panel ─────────────────────────────── */
#ni-cmd-panel {
  position:fixed; bottom:80px; right:24px; z-index:9989;
  width:520px; max-height:calc(100vh - 104px);
  background:linear-gradient(160deg,var(--bg-elev) 0%,var(--bg-subtle) 100%);
  border:1.5px solid rgba(199,198,189,0.7);
  border-radius:20px;
  box-shadow:0 24px 64px rgba(26,27,31,0.18),0 8px 24px rgba(26,27,31,0.1),0 1px 4px rgba(26,27,31,0.06);
  overflow:hidden; display:flex; flex-direction:column;
  opacity:0; transform:translateY(20px) scale(0.96); pointer-events:none;
  transition:opacity 220ms ease,transform 260ms cubic-bezier(0.34,1.56,0.64,1);
}
#ni-cmd-panel.ni-cp-open { opacity:1; transform:translateY(0) scale(1); pointer-events:auto; }

.ni-cp-search-row {
  display:flex; align-items:center;
  padding:16px 18px; gap:12px;
  border-bottom:1px solid var(--line);
  transition:border-color 0.15s;
}
#ni-cmd-panel.ni-cp-focused .ni-cp-search-row { border-bottom-color:var(--accent-soft); }
.ni-cp-search-icon { width:18px; height:18px; color:var(--fg-mute); flex-shrink:0; stroke-width:2; }
.ni-cp-input { flex:1; border:none; outline:none; background:transparent;
  font-size:15px; font-family:inherit; color:var(--fg); caret-color:var(--accent); }
.ni-cp-input::placeholder { color:var(--fg-faint); }
.ni-cp-kbd-badge { font-size:10px; font-weight:700; letter-spacing:0.06em;
  background:var(--bg-subtle); border:1px solid var(--line-strong);
  border-radius:6px; padding:2px 8px; color:var(--fg-mute);
  flex-shrink:0; box-shadow:0 1px 0 var(--line-strong); }

.ni-cp-results { flex:1; min-height:0; overflow-y:auto; padding:6px 0; }
.ni-cp-results::-webkit-scrollbar { width:4px; }
.ni-cp-results::-webkit-scrollbar-track { background:transparent; }
.ni-cp-results::-webkit-scrollbar-thumb { background:var(--line-strong); border-radius:2px; }

.ni-cp-section { font-size:10px; font-weight:700; letter-spacing:0.12em;
  text-transform:uppercase; color:var(--fg-faint); padding:10px 18px 4px; }
.ni-cp-section:not(:first-child) { border-top:1px solid var(--line); margin-top:4px; }

.ni-cp-result { display:grid; grid-template-columns:40px 1fr auto;
  align-items:center; gap:0 12px;
  padding:9px 12px; margin:1px 6px;
  border-radius:10px; cursor:pointer;
  border-left:2px solid transparent;
  transition:background 0.08s,border-color 0.08s; }
.ni-cp-result:hover { background:var(--accent-wash); }
.ni-cp-result.active { background:var(--accent-wash); border-left-color:var(--accent); }

.ni-cp-result-icon { font-size:16px; line-height:1;
  width:36px; height:36px; display:flex; align-items:center; justify-content:center;
  background:var(--bg-subtle); border-radius:8px; flex-shrink:0; }
.ni-cp-result-body { display:flex; flex-direction:column; gap:2px; min-width:0; }
.ni-cp-result-label { font-size:13px; font-weight:600; color:var(--fg);
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ni-cp-result-sub { font-size:11px; color:var(--fg-mute);
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ni-cp-result-type { font-size:9.5px; font-weight:700; letter-spacing:0.08em;
  text-transform:uppercase; border-radius:4px; padding:2px 6px;
  flex-shrink:0; align-self:flex-start; margin-top:1px; }
.ni-cp-result-type[data-t="action"] { color:var(--accent); background:var(--accent-wash); }
.ni-cp-result-type[data-t="line"]   { color:#3d85c8; background:rgba(61,133,200,0.1); }
.ni-cp-result-type[data-t="order"]  { color:#4a9e6a; background:rgba(74,158,106,0.1); }

.ni-cp-result mark { background:transparent; color:var(--accent); font-weight:700; }
.ni-cp-empty { padding:28px 18px; text-align:center; font-size:13px; color:var(--fg-faint); }

.ni-cp-footer { padding:8px 18px; font-size:11px; color:var(--fg-faint);
  border-top:1px solid var(--line); display:flex; gap:14px; align-items:center;
  background:var(--bg-subtle); }
.ni-cp-hint { display:flex; align-items:center; gap:4px; }
.ni-cp-hint kbd { display:inline-block; font-family:inherit; font-size:10px; font-weight:700;
  background:var(--bg-elev); border:1px solid var(--line-strong);
  border-radius:4px; padding:1px 5px; color:var(--fg-mute);
  box-shadow:0 1px 0 var(--line-strong); }
body.dark #ni-cmd-fab {
  background:#ffffff;
  color:#13141a;
  box-shadow:0 4px 16px rgba(0,0,0,0.5),0 1px 4px rgba(0,0,0,0.3);
}
body.dark #ni-cmd-fab:hover {
  /* Hardcoded (not var(--bg-subtle)): this rule inverts the FAB to a near-white
     circle in dark mode, but body.dark redefines --bg-subtle to a DARK value —
     using the var() here would repaint the button dark instead of a cool-tinted
     near-white hover shade. */
  background:#f4f7fa;
  box-shadow:0 6px 24px rgba(0,0,0,0.55),0 2px 6px rgba(0,0,0,0.35);
}
body.dark #ni-cmd-fab.ni-fab-active {
  background:#ffffff;
  box-shadow:0 4px 20px rgba(255,255,255,0.15),0 2px 8px rgba(0,0,0,0.4);
}
body.dark #ni-cmd-panel {
  background:linear-gradient(160deg,#1c1d26 0%,#191a22 100%);
  border-color:rgba(56,58,80,0.8);
}
body.dark .ni-cp-footer { background:var(--bg-strong); }
body.dark .ni-cp-result-icon { background:var(--bg-subtle); }

/* ── Dark Mode Pill (lives in command palette footer) ────── */
#ni-dm-pill {
  display:inline-flex; align-items:center; gap:4px;
  width:52px; height:22px; border-radius:100px; padding:2px 3px;
  background:var(--bg-elev); border:1px solid var(--line-strong);
  cursor:pointer; position:relative; flex-shrink:0; margin-left:6px;
  transition:border-color var(--t-med), background var(--t-med);
  box-shadow:inset 0 1px 2px rgba(0,0,0,0.07);
}
#ni-dm-pill:hover { border-color:var(--accent); }
#ni-dm-pill .ni-dm-icon { font-size:11px; line-height:1; z-index:1; transition:opacity 0.2s; width:18px; text-align:center; }
#ni-dm-pill .ni-dm-thumb {
  position:absolute; top:2px; left:2px;
  width:18px; height:16px; border-radius:100px;
  background:var(--accent); opacity:0.9;
  transition:transform var(--t-med) cubic-bezier(0.34,1.4,0.64,1);
  box-shadow:0 1px 3px rgba(0,0,0,0.18);
}
#ni-dm-pill.ni-dm-dark .ni-dm-thumb { transform:translateX(24px); }
#ni-dm-pill .ni-dm-icon:first-child { opacity:1; }
#ni-dm-pill .ni-dm-icon:last-child  { opacity:0.4; }
#ni-dm-pill.ni-dm-dark .ni-dm-icon:first-child { opacity:0.4; }
#ni-dm-pill.ni-dm-dark .ni-dm-icon:last-child  { opacity:1; }

/* ── Language Switcher Pill ──────────────────────────────── */
#ni-lang-pill{position:relative;display:flex;align-items:center;gap:4px;padding:3px 8px;border-radius:100px;background:var(--bg-elev);border:1px solid var(--line-strong);cursor:pointer;font-size:11px;font-weight:600;color:var(--fg);user-select:none;white-space:nowrap;}
#ni-lang-pill:hover{border-color:var(--accent);}
.ni-lang-caret{font-size:9px;opacity:.7;}
.ni-lang-dropdown{display:none;position:absolute;bottom:calc(100% + 6px);left:0;min-width:160px;background:var(--bg-elev);border:1px solid var(--line-strong);border-radius:8px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,.18);z-index:9999;}
.ni-lang-dropdown.ni-lang-open{display:block;}
.ni-lang-opt{display:block;width:100%;padding:7px 12px;background:none;border:none;text-align:left;font-size:12px;color:var(--fg);cursor:pointer;}
.ni-lang-opt:hover{background:var(--bg-hover,rgba(255,255,255,.06));}
.ni-lang-opt.ni-lang-active{color:var(--accent);font-weight:600;}

/* ── Command palette close button ───────────────────────── */
.ni-cp-close-btn {
  background:none; border:none; cursor:pointer; font-size:13px;
  color:var(--fg-mute); opacity:0.55; padding:3px 7px; border-radius:5px;
  transition:opacity 0.12s, background 0.12s; flex-shrink:0; line-height:1;
}
.ni-cp-close-btn:hover { opacity:1; background:var(--bg-subtle); }

/* ── Command palette footer count ───────────────────────── */
.ni-cp-index-count { margin-left:auto; font-size:10px; color:var(--fg-faint); font-variant-numeric:tabular-nums; }

/* ── Time Machine ──────────────────────────────────────── */
.ni-tm-panel { position:fixed; top:calc(var(--chrome-h) + 8px); right:16px; width:340px; max-height:480px;
  background:var(--bg-elev); border:1.5px solid var(--line-strong); border-radius:var(--r-xl);
  box-shadow:var(--shadow-lg); z-index:500; display:flex; flex-direction:column; overflow:hidden; }
.ni-tm-panel[hidden] { display:none !important; }
.ni-tm-head { display:flex; align-items:center; justify-content:space-between; padding:12px 14px;
  border-bottom:1px solid var(--line); font-size:13px; }
.ni-tm-close { background:none; border:none; cursor:pointer; font-size:16px; color:var(--fg-mute); padding:2px 6px; }
.ni-tm-list { overflow-y:auto; flex:1; }
.ni-tm-row { display:grid; grid-template-columns:72px 1fr auto; align-items:center; gap:8px;
  padding:7px 14px; border-bottom:1px solid var(--bg-subtle); }
.ni-tm-row:hover { background:var(--bg-subtle); }
.ni-tm-time { font-size:10.5px; font-family:'JetBrains Mono',monospace; color:var(--fg-mute); white-space:nowrap; }
.ni-tm-label { font-size:12px; color:var(--fg); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ni-tm-restore-btn { font-size:11px; padding:3px 8px; background:var(--bg-subtle); border:1px solid var(--line);
  border-radius:var(--r-sm); cursor:pointer; white-space:nowrap; }
.ni-tm-restore-btn:hover { border-color:var(--accent); color:var(--accent); }

/* ── Confidence badge ──────────────────────────────────── */
/* This badge mounts into .topbar-actions on the permanently-dark command band
   (Command Band re-skin, Task 7) — it must use the fixed-dark --chrome-* group,
   not the light-page --bg-subtle/--line/--fg-mute tokens it previously used
   (those read as a mismatched light chip floating on the navy band). Colour
   values only; no markup/behavior change. */
.ni-conf-badge { display:flex; align-items:center; gap:6px; padding:3px 10px;
  background:var(--chrome-panel); border:1.5px solid var(--chrome-border); border-radius:20px;
  cursor:pointer; transition:border-color 0.15s; position:relative; }
.ni-conf-badge:hover { border-color:var(--chrome-accent); }
.ni-conf-label { font-size:11px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; color:var(--chrome-fg-mute); }
.ni-conf-score { font-size:13px; font-weight:700; font-family:'JetBrains Mono',monospace; min-width:24px; text-align:right; }
.ni-conf-ring { display:inline-block; position:relative; width:16px; height:16px;
  border-radius:50%; flex-shrink:0; }
.ni-conf-ring::after { content:''; position:absolute; inset:3px; border-radius:50%; background:var(--chrome-panel); }
.ni-conf-delta { position:absolute; top:-8px; right:4px; font-size:10px; font-weight:700;
  font-family:'JetBrains Mono',monospace; animation:ni-fade-up 1.8s ease forwards; pointer-events:none; }
@keyframes ni-fade-up { 0%{opacity:1;transform:translateY(0)} 100%{opacity:0;transform:translateY(-12px)} }

/* ── Ripple preview ────────────────────────────────────── */
.ni-ripple-ghost { border:1.5px dashed var(--err) !important; background:rgba(177,54,42,0.18) !important;
  pointer-events:none !important; transition:opacity 0.15s; }
#vis-timeline, #vis-timeline .vis-panel, #vis-timeline .vis-itemset { cursor: default; }
#vis-timeline.ripple-mode,
#vis-timeline.ripple-mode .vis-panel,
#vis-timeline.ripple-mode .vis-itemset { cursor: crosshair; }

/* ── Diff dialog ───────────────────────────────────────── */
.ni-diff-dlg { border:none; padding:0; border-radius:var(--r-xl); box-shadow:var(--shadow-lg); width:720px; max-width:96vw; }
.ni-diff-dlg::backdrop { background:rgba(26,27,31,0.45); }
.ni-diff-dlg > div { background:var(--bg-elev); border-radius:var(--r-xl); }
/* snap picker list */
.ni-diff-snaplist { max-height:200px; overflow-y:auto; border:1.5px solid var(--line);
  border-radius:var(--r-md); background:var(--bg); scrollbar-width:thin; scrollbar-color:var(--line) transparent; }
.ni-diff-snaplist::-webkit-scrollbar { width:5px; }
.ni-diff-snaplist::-webkit-scrollbar-thumb { background:var(--line); border-radius:3px; }
.ni-diff-snap-row { display:grid; grid-template-columns:88px 1fr auto; align-items:center; gap:8px;
  padding:8px 12px; cursor:pointer; border-bottom:1px solid var(--line); border-left:2px solid transparent; transition:background 0.1s,border-color 0.1s; }
.ni-diff-snap-row:last-child { border-bottom:none; }
.ni-diff-snap-row:hover { background:var(--bg-subtle); }
.ni-diff-snap-row.ni-diff-snap-sel { background:color-mix(in srgb,var(--accent) 10%,transparent); border-left-color:var(--accent); }
.ni-diff-snap-ago { font-size:10.5px; font-family:'JetBrains Mono',monospace; color:var(--fg-mute); white-space:nowrap; }
.ni-diff-snap-lbl { font-size:12px; color:var(--fg); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ni-diff-snap-badge { font-size:9.5px; font-weight:700; text-transform:uppercase; letter-spacing:0.06em;
  padding:2px 5px; border-radius:3px; white-space:nowrap; }
.ni-diff-snap-badge.auto { background:var(--bg-subtle); color:var(--fg-mute); }
.ni-diff-snap-badge.manual { background:color-mix(in srgb,var(--amber,#c68f24) 18%,transparent); color:var(--amber,#c68f24); }
/* stat strip */
.ni-diff-stat-strip { display:flex; gap:8px; margin-bottom:14px; }
.ni-diff-stat { flex:1; padding:10px 12px; border-radius:var(--r-md); text-align:center;
  background:var(--bg-subtle); border:1.5px solid var(--line); }
.ni-diff-stat-num { font-size:26px; font-weight:700; line-height:1; font-family:'JetBrains Mono',monospace; }
.ni-diff-stat-lbl { font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:0.07em;
  color:var(--fg-mute); margin-top:3px; }
.ni-diff-stat.moved  .ni-diff-stat-num { color:var(--warn,#b57a0a); }
.ni-diff-stat.added  .ni-diff-stat-num { color:var(--ok,#2f7a4d); }
.ni-diff-stat.removed .ni-diff-stat-num { color:var(--err,#b1362a); }
/* results area */
.ni-diff-results { max-height:400px; overflow-y:auto; margin-top:12px;
  scrollbar-width:thin; scrollbar-color:var(--line) transparent; }
.ni-diff-results::-webkit-scrollbar { width:5px; }
.ni-diff-results::-webkit-scrollbar-thumb { background:var(--line); border-radius:3px; }
.ni-diff-section-hd { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:0.08em;
  color:var(--fg-mute); margin:12px 0 6px; display:flex; align-items:center; gap:6px; }
.ni-diff-section-ct { background:var(--bg-subtle); border:1px solid var(--line); border-radius:10px;
  font-size:10px; padding:1px 7px; color:var(--fg-mute); font-variant-numeric:tabular-nums; }
/* row cards */
.ni-diff-row { display:flex; flex-direction:column; gap:5px;
  padding:9px 10px; border-radius:var(--r-sm); font-size:12px; margin-bottom:3px;
  border-left:3px solid transparent; transition:background 0.1s; }
.ni-diff-row:hover { filter:brightness(1.04); }
.ni-diff-row-moved   { background:color-mix(in srgb,var(--warn,#b57a0a) 7%,transparent); border-left-color:var(--warn,#b57a0a); }
.ni-diff-row-added   { background:color-mix(in srgb,var(--ok,#2f7a4d) 7%,transparent);   border-left-color:var(--ok,#2f7a4d); }
.ni-diff-row-removed { background:color-mix(in srgb,var(--err,#b1362a) 7%,transparent);  border-left-color:var(--err,#b1362a); }
.ni-diff-row-top    { display:flex; align-items:center; gap:8px; min-width:0; }
.ni-diff-row-bottom { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
.ni-diff-po   { font-family:'JetBrains Mono',monospace; font-size:10.5px; color:var(--fg-mute); white-space:nowrap; flex-shrink:0; }
.ni-diff-desc { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--fg); font-weight:500; }
.ni-diff-shift { font-size:12px; font-weight:700; white-space:nowrap; flex-shrink:0; }
.ni-diff-shift.later   { color:var(--warn,#b57a0a); }
.ni-diff-shift.earlier { color:var(--accent,#5c7bff); }
.ni-diff-shift.added   { color:var(--ok,#2f7a4d); }
.ni-diff-shift.removed { color:var(--err,#b1362a); }
.ni-diff-dates { font-family:'JetBrains Mono',monospace; font-size:10.5px; color:var(--fg-mute); white-space:nowrap; flex:1; overflow:hidden; text-overflow:ellipsis; }
.ni-diff-line-chip { display:inline-block; font-size:9.5px; background:var(--bg-subtle);
  border:1px solid var(--line); border-radius:3px; padding:1px 5px; color:var(--fg-mute); white-space:nowrap; flex-shrink:0; }
.ni-diff-line-summary { margin-top:10px; padding:8px 10px; background:var(--bg-subtle);
  border-radius:var(--r-md); font-size:11.5px; color:var(--fg-mute); line-height:1.7; }


/* ── Generic breakdown dialog ────────────────────────── */
.ni-breakdown-dlg { border:none; padding:0; border-radius:var(--r-xl); box-shadow:var(--shadow-lg); }
.ni-breakdown-dlg::backdrop { background:rgba(26,27,31,0.45); }
.ni-breakdown-dlg > div { background:var(--bg-elev); border-radius:var(--r-xl); }

/* ── CommandPalette: Right Now / Selection / Intent item types ───── */
.ni-cp-section.ni-cp-section--right-now { color:var(--amber,#c68f24); }
.ni-cp-result[data-t="need"]      { border-left:3px solid var(--amber,#c68f24); }
.ni-cp-result[data-t="selection"] { border-left:3px solid var(--accent,#5c7bff); }
.ni-cp-result[data-t="intent"]    { border-left:3px solid var(--ok,#2f7a4d); }
.ni-cp-result[data-t="need"] .ni-cp-result-type,
.ni-cp-result[data-t="selection"] .ni-cp-result-type,
.ni-cp-result[data-t="intent"] .ni-cp-result-type { display:none; }
.ni-cp-need-dot { display:inline-block; width:6px; height:6px; border-radius:50%;
  background:var(--amber,#c68f24); margin-right:5px; vertical-align:middle;
  animation:ni-need-pulse 1.8s ease-in-out infinite; }
@keyframes ni-need-pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:0.45;transform:scale(0.7)} }
.ni-cp-hint kbd { font-family:inherit; }
`;
    document.head.appendChild(s);
  })();

  /* ==========================================================================
     INTEL DB — shared IndexedDB for snapshots, scenarios, patterns
     ========================================================================== */
  const IntelDB = {
    _db: null,

    open() {
      return new Promise((res, rej) => {
        const req = indexedDB.open('nimbus-intel', 1);
        req.onupgradeneeded = e => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains('snapshots')) {
            const ss = db.createObjectStore('snapshots', { keyPath: 'id', autoIncrement: true });
            ss.createIndex('ts', 'ts');
          }
          if (!db.objectStoreNames.contains('scenarios'))
            db.createObjectStore('scenarios', { keyPath: 'name' });
          if (!db.objectStoreNames.contains('patterns'))
            db.createObjectStore('patterns', { keyPath: 'key' });
        };
        req.onsuccess = e => { IntelDB._db = e.target.result; res(IntelDB._db); };
        req.onerror   = e => {
          (window.NIMBUS && window.NIMBUS.ErrorLog
            ? window.NIMBUS.ErrorLog.warn('intel', '[IntelDB] open failed', { err: String(e.target.error), errorCode: 'internal' })
            : console.warn('[IntelDB]', e.target.error));
          rej(e.target.error);
        };
      });
    },

    put(store, value) {
      if (!IntelDB._db) return Promise.resolve();
      return new Promise((res, rej) => {
        const tx = IntelDB._db.transaction(store, 'readwrite');
        tx.objectStore(store).put(value);
        tx.oncomplete = res;
        tx.onerror    = e => rej(e.target.error);
      });
    },

    get(store, key) {
      if (!IntelDB._db) return Promise.resolve(null);
      return new Promise((res, rej) => {
        const tx  = IntelDB._db.transaction(store, 'readonly');
        const req = tx.objectStore(store).get(key);
        req.onsuccess = e => res(e.target.result || null);
        req.onerror   = e => rej(e.target.error);
      });
    },

    getAll(store) {
      if (!IntelDB._db) return Promise.resolve([]);
      return new Promise((res, rej) => {
        const tx  = IntelDB._db.transaction(store, 'readonly');
        const req = tx.objectStore(store).getAll();
        req.onsuccess = e => res(e.target.result || []);
        req.onerror   = e => rej(e.target.error);
      });
    },

    deleteRecord(store, key) {
      if (!IntelDB._db) return Promise.resolve();
      return new Promise((res, rej) => {
        const tx = IntelDB._db.transaction(store, 'readwrite');
        tx.objectStore(store).delete(key);
        tx.oncomplete = res;
        tx.onerror    = e => rej(e.target.error);
      });
    },

    pruneSnapshots(keepN = 200) {
      if (!IntelDB._db) return;
      const fn = () => {
        IntelDB.getAll('snapshots').then(all => {
          if (!all || all.length <= keepN) return;
          const toDelete = all
            .sort((a, b) => a.ts - b.ts)
            .slice(0, all.length - keepN);
          const tx = IntelDB._db.transaction('snapshots', 'readwrite');
          const os = tx.objectStore('snapshots');
          toDelete.forEach(s => os.delete(s.id));
        });
      };
      if (window.requestIdleCallback) window.requestIdleCallback(fn, { timeout: 2000 });
      else setTimeout(fn, 2000);
    }
  };

  /* ==========================================================================
     NEEDS ENGINE — scores ~20 need-templates against live schedule state;
     powers the Command Palette "Right Now" section and "need:" intent prefix
     ========================================================================== */
  const NeedsEngine = {
    _cachedState: null,

    _readState() {
      const alerts   = Store.alerts || [];
      const tasks    = Store.tasksArr;
      const errAlerts  = alerts.filter(a => a.sev === 'err');
      const warnAlerts = alerts.filter(a => a.sev === 'warn');
      const unscheduled = tasks.filter(t => !t.start_date || !t.end_date);

      // Peak utilization — use sync compute, but trigger worker refresh for next call
      let maxUtil = 0, overloadedLine = null;
      try {
        const now = Util.startOfDay(new Date());
        const startMs = now.getTime();
        const days = 7;
        const rev = Store.rev();
        const plant = Store.selectedPlant;

        let matrix = null;
        // Try cached worker result first, fall back to sync
        if (Utilization._cache && Utilization._cache.key === `${startMs}|${days}|${rev}|${plant}`) {
          matrix = Utilization._cache.matrix;
        } else {
          // Compute synchronously
          matrix = Utilization.computeMatrix(now, days);
          // Post async refresh to worker if available
          if (NIMBUS.Compute && NIMBUS.Compute.available() && plant) {
            NIMBUS.Compute.utilization(startMs, days)
              .then(({ matrix: m }) => {
                if (Store.rev() !== rev) return; // stale
                Utilization._cache = { key: `${startMs}|${days}|${rev}|${plant}`, matrix: m };
              })
              .catch(() => {});
          }
        }

        for (const [line, lineData] of Object.entries(matrix)) {
          for (const row of Object.values(lineData)) {
            if (row.effectiveCapacity > 0) {
              const ratio = row.scheduled / row.effectiveCapacity;
              if (ratio > maxUtil) { maxUtil = ratio; overloadedLine = line; }
            }
          }
        }
      } catch (e) {
        (window.NIMBUS && window.NIMBUS.ErrorLog
          ? window.NIMBUS.ErrorLog.warn('intel', 'NeedsEngine util scan failed', { err: String(e), errorCode: 'internal' })
          : console.warn('[NeedsEngine] util scan failed', e));
      }

      // Last snapshot age — scoped to current plant only
      const plantSnaps = TimeMachine._plantSnaps();
      const lastSnap = plantSnaps.length ? plantSnaps[plantSnaps.length - 1] : null;
      const minsSinceSnap = lastSnap ? Math.floor((Date.now() - lastSnap.ts) / 60000) : null;

      // Confidence delta (last 2 history entries)
      const ch = Confidence._history;
      const confDelta = ch.length >= 2 ? ch[ch.length - 1].score - ch[ch.length - 2].score : 0;

      // Selection
      const selIds  = NIMBUS.Selection?.ids?.() || [];
      const selSize = selIds.length;
      const selStats = selSize ? (NIMBUS.Selection?.stats?.() || {}) : {};

      // Blackout risk (orders within 48h of a blackout)
      let blackoutRisk = 0;
      try {
        const now2    = Date.now();
        const horizon = now2 + 48 * 3600000;
        const bkts = Store.blocks.concat(Store.plantBlocks).filter(b => b.start > now2 && b.start < horizon);
        if (bkts.length) {
          blackoutRisk = tasks.filter(t => t.end_date && bkts.some(b =>
            t.end_date.getTime() > b.start && (t.start_date?.getTime() ?? 0) < b.end
          )).length;
        }
      } catch (e) {
        (window.NIMBUS && window.NIMBUS.ErrorLog
          ? window.NIMBUS.ErrorLog.warn('intel', 'NeedsEngine blackout-risk scan failed', { err: String(e), errorCode: 'internal' })
          : console.warn('[NeedsEngine] blackout-risk scan failed', e));
      }

      return {
        errCount:       errAlerts.length,
        warnCount:      warnAlerts.length,
        firstErrTaskId: errAlerts[0]?.taskId,
        unscheduledCount: unscheduled.length,
        maxUtil,
        overloadedLine,
        minsSinceSnap,
        confScore:     Confidence._score,
        confDelta,
        selSize,
        selIds,
        selStats,
        sandboxActive:  !!NIMBUS.Sandbox?.active,
        anyFilterActive: !!(
          NIMBUS.GanttFilter?.activeFilter()?.color ||
          NIMBUS.GanttFilter?.activeFilter()?.form  ||
          NIMBUS.GanttFilter?.activeFilter()?.text  ||
          (NIMBUS.GanttFilter?.selectedLines()?.size > 0)
        ),
        undoDepth:     NIMBUS.UndoStack?._entries?.length || 0,
        blackoutRisk,
        snapshotCount: plantSnaps.length,
        hasPlant:      !!Store.selectedPlant,
      };
    },

    _bank: null,

    _buildBank() {
      return [
        {
          id: 'conflict-jump',
          label: s => `${s.errCount} conflict${s.errCount !== 1 ? 's' : ''} — jump to first`,
          sub:   () => 'Scroll Gantt to nearest overlap or error',
          icon:  '🚨',
          score: s => s.errCount > 0 ? 90 + Math.min(s.errCount * 2, 9) : 0,
          when:  s => s.errCount > 0 && s.hasPlant,
          run()  {
            CommandPalette.close();
            const err = (Store.alerts || []).filter(a => a.sev === 'err').sort((a, b) => a.time - b.time)[0];
            if (!err) { Toast.show(t('toast.no_active_conflicts'), 'info', 1800); return; }
            NIMBUS.App.gotoGanttTimeline();
            setTimeout(() => { if (err.taskId) NIMBUS.Timeline.focus(String(err.taskId)); }, 100);
          }
        },
        {
          id: 'overload-inspect',
          label: s => `${s.overloadedLine} is overloaded (${Math.round(s.maxUtil * 100)}%)`,
          sub:   () => 'Scroll Gantt to overloaded line',
          icon:  '⚠️',
          score: s => s.maxUtil >= 1.0 ? 70 + Math.min(Math.round((s.maxUtil - 1) * 50), 20) : 0,
          when:  s => s.maxUtil >= 1.0 && s.hasPlant,
          run(s) {
            CommandPalette.close();
            NIMBUS.App.gotoGanttTimeline();
            const sample = Store.tasksArr.find(t => t.PRODUCTION_LINE === s.overloadedLine);
            if (sample) setTimeout(() => NIMBUS.Timeline.focus(String(sample.id)), 100);
          }
        },
        {
          id: 'unscheduled-review',
          label: s => `${s.unscheduledCount} order${s.unscheduledCount !== 1 ? 's' : ''} without a time slot`,
          sub:   () => 'Switch to Orders table to review',
          icon:  '📋',
          score: s => s.unscheduledCount > 0 ? 60 + Math.min(s.unscheduledCount, 15) : 0,
          when:  s => s.unscheduledCount > 0 && s.hasPlant,
          run()  { CommandPalette.close(); NIMBUS.App.goto('table'); }
        },
        {
          id: 'snapshot-due',
          label: s => `Last snapshot ${s.minsSinceSnap}m ago — save now`,
          sub:   () => 'Take a Time Machine checkpoint',
          icon:  '📸',
          score: s => (s.minsSinceSnap !== null && s.minsSinceSnap >= 20)
            ? 40 + Math.min(Math.floor(s.minsSinceSnap / 5), 25) : 0,
          when:  s => s.minsSinceSnap !== null && s.minsSinceSnap >= 20 && s.hasPlant,
          run()  {
            CommandPalette.close();
            const label = `Manual · ${new Date().toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' })}`;
            TimeMachine.snapshot(label);
            Toast.show(t('toast.snapshot_saved'), 'success', 1400);
          }
        },
        {
          id: 'first-snapshot',
          label: () => 'No snapshots yet — save a checkpoint now',
          sub:   () => 'Save your first Time Machine entry',
          icon:  '📸',
          score: s => s.snapshotCount === 0 && s.hasPlant ? 55 : 0,
          when:  s => s.snapshotCount === 0 && s.hasPlant,
          run()  {
            CommandPalette.close();
            const label = `First snapshot · ${new Date().toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' })}`;
            TimeMachine.snapshot(label);
            Toast.show(t('toast.snapshot_saved'), 'success', 1400);
          }
        },
        {
          id: 'blackout-risk',
          label: s => `${s.blackoutRisk} order${s.blackoutRisk !== 1 ? 's' : ''} near an upcoming blackout`,
          sub:   () => 'Review orders overlapping a scheduled blackout block',
          icon:  '🚫',
          score: s => s.blackoutRisk > 0 ? 75 : 0,
          when:  s => s.blackoutRisk > 0 && s.hasPlant,
          run()  {
            CommandPalette.close();
            NIMBUS.App.gotoGanttTimeline();
            Toast.show(t('toast.check_gantt_blackout'), 'warn', 3000);
          }
        },
        {
          id: 'sandbox-active',
          label: () => 'Sandbox is active — apply or discard',
          sub:   () => 'You are in what-if mode',
          icon:  '🔮',
          score: s => s.sandboxActive ? 85 : 0,
          when:  s => s.sandboxActive,
          run()  { CommandPalette.close(); NIMBUS.Sandbox?.showPanel?.(); }
        },
        {
          id: 'diff-available',
          label: () => 'Compare to a previous snapshot',
          sub:   () => 'Open the schedule diff viewer',
          icon:  '⇄',
          score: s => s.snapshotCount > 1 && s.confDelta >= -5 ? 35 : 0,
          when:  s => s.snapshotCount > 1 && s.hasPlant,
          run()  { CommandPalette.close(); Diff.showUI(); }
        },
      ];
    },

    topNeeds(n = 5) {
      if (!NeedsEngine._cachedState) NeedsEngine._cachedState = NeedsEngine._readState();
      const s = NeedsEngine._cachedState;
      return NeedsEngine._bank
        .map(need => ({ need, score: need.score(s) }))
        .filter(({ need, score }) => score > 0 && need.when(s))
        .sort((a, b) => b.score - a.score)
        .slice(0, n)
        .map(({ need }) => ({
          type:  'need',
          icon:  need.icon,
          label: typeof need.label === 'function' ? need.label(s) : need.label,
          sub:   typeof need.sub   === 'function' ? need.sub(s)   : need.sub,
          run:   () => need.run(s)
        }));
    },

    resolveIntent(text) {
      const q = text.trim().toLowerCase();
      const bank = [
        {
          keywords: ['freeze', 'lock', 'fix all', 'pin'],
          label: 'Freeze: Fix all orders + take snapshot',
          sub:   'Pins every order and saves a Time Machine checkpoint',
          icon:  '🔒',
          run() {
            CommandPalette.close();
            NIMBUS.UndoStack?.push?.('Fix All (freeze)', () => {});
            const unfixedIds = Store.tasksArr.filter(t => !Store.isFixed(t.id)).map(t => t.id);
            if (unfixedIds.length) Store.setFixed(unfixedIds, true, 'cmd-palette');
            Alerts.scheduleRecompute();
            const label = `Frozen · ${new Date().toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' })}`;
            TimeMachine.snapshot(label);
            Toast.show(t('toast.freeze_saved'), 'success', 3000);
          }
        },
        {
          keywords: ['compare', 'diff', 'what changed', 'changed', 'delta'],
          label: 'Compare to a previous snapshot',
          sub:   'Open the schedule diff viewer',
          icon:  '⇄',
          run()  { CommandPalette.close(); Diff.showUI(); }
        },
        {
          keywords: ['rush', 'urgent', 'emergency', 'priority', 'hot'],
          label: 'Rush order: Enter Sandbox what-if mode',
          sub:   'Explore changes without touching the live schedule',
          icon:  '🔮',
          run()  { CommandPalette.close(); NIMBUS.SandboxAdapter?.enter?.(); }
        },
        {
          keywords: ['optimize', 'run optim', 'scheduler', 'reorder'],
          label: 'Optimize Schedule',
          sub:   'Run the NIMBUS optimizer',
          icon:  '⚙',
          run()  { CommandPalette.close(); NIMBUS.OptimizeDialog?.open?.(); }
        },
        {
          keywords: ['export', 'print', 'pdf', 'download', 'report'],
          label: 'Print / Export schedule',
          sub:   'Open the export dialog',
          icon:  '🖨️',
          run()  { CommandPalette.close(); NIMBUS.Printer?.open?.(); }
        },
        {
          keywords: ['snapshot', 'save', 'checkpoint', 'backup', 'history'],
          label: 'Take a snapshot now',
          sub:   'Save a Time Machine checkpoint',
          icon:  '📸',
          run()  {
            CommandPalette.close();
            const label = `Intent · ${new Date().toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' })}`;
            TimeMachine.snapshot(label);
            Toast.show(t('toast.snapshot_saved'), 'success', 1400);
          }
        },
        {
          keywords: ['conflict', 'error', 'overlap', 'alert', 'problem'],
          label: 'Jump to first conflict',
          sub:   'Scroll Gantt to nearest error alert',
          icon:  '🚨',
          run()  {
            CommandPalette.close();
            const err = (Store.alerts || []).filter(a => a.sev === 'err').sort((a, b) => a.time - b.time)[0];
            if (!err) { Toast.show(t('toast.no_conflicts_clean'), 'info', 1800); return; }
            NIMBUS.App.gotoGanttTimeline();
            setTimeout(() => { if (err.taskId) NIMBUS.Timeline.focus(String(err.taskId)); }, 100);
          }
        },
      ];

      const results = bank.filter(intent => intent.keywords.some(kw => q.includes(kw)));
      if (!results.length) {
        // Loose word-level fallback
        const words = q.split(/\s+/);
        return bank
          .filter(intent => intent.keywords.some(kw => words.some(w => kw.includes(w) && w.length > 2)))
          .slice(0, 3)
          .map(intent => ({ type:'intent', icon:intent.icon, label:intent.label, sub:intent.sub, run:intent.run }));
      }
      return results.map(intent => ({ type:'intent', icon:intent.icon, label:intent.label, sub:intent.sub, run:intent.run }));
    },

    init() {
      NeedsEngine._bank = NeedsEngine._buildBank();
      Store.subscribe(() => { NeedsEngine._cachedState = null; });
    }
  };

  /* ==========================================================================
     COMMAND PALETTE — Cmd/Ctrl+K fuzzy search
     ========================================================================== */
  const CommandPalette = {
    _panel:     null,
    _index:     null,
    _results:   [],
    _cursor:    0,
    _lastQuery: '',
    _recent: {
      _key: 'nimbus.recentCmds',
      get() { try { return JSON.parse(localStorage.getItem('nimbus.recentCmds')) || []; } catch { return []; } },
      push(label) {
        const a = CommandPalette._recent.get().filter(l => l !== label);
        a.unshift(label);
        localStorage.setItem('nimbus.recentCmds', JSON.stringify(a.slice(0, 5)));
      }
    },

    init() {
      CommandPalette._buildPanel();
      document.addEventListener('keydown', e => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
          e.preventDefault();
          if (!Store.selectedPlant) return;
          CommandPalette.open();
        }
      });
      Store.subscribe(evt => {
        if (!evt?.type || evt.type === 'tasks:bulk' || evt.type === 'tasks:bulkUpdate' || evt.type === 'plant:selected')
          CommandPalette._index = null;
        if (evt?.type === 'plant:selected') {
          const fab = document.getElementById('ni-cmd-fab');
          if (!fab) return;
          if (Store.selectedPlant) {
            fab.classList.remove('ni-fab-locked');
          } else {
            fab.classList.add('ni-fab-locked');
            CommandPalette.close();
          }
        }
      });
      // Rebuild index when selection changes so selection commands stay current
      NIMBUS.Selection?.on?.(() => {
        CommandPalette._index = null;
        NeedsEngine._cachedState = null;
      });
    },

    _buildPanel() {
      const fab = document.createElement('button');
      fab.id = 'ni-cmd-fab';
      fab.setAttribute('aria-label', NIMBUS.Util.t('aria.open_command_palette'));
      fab.textContent = '🧹';
      fab.addEventListener('click', () => {
        if (fab.classList.contains('ni-fab-locked')) return;
        document.getElementById('alert-drawer')?.classList.remove('open');
        CommandPalette.isOpen() ? CommandPalette.close() : CommandPalette.open();
      });
      if (!Store.selectedPlant) fab.classList.add('ni-fab-locked');
      document.body.appendChild(fab);

      const panel = document.createElement('div');
      panel.id = 'ni-cmd-panel';
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-label', NIMBUS.Util.t('aria.command_palette'));
      panel.innerHTML = `
        <div class="ni-cp-search-row">
          <svg class="ni-cp-search-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor">
            <circle cx="8.5" cy="8.5" r="5.5"/><path d="M14 14l3.5 3.5" stroke-linecap="round"/>
          </svg>
          <input class="ni-cp-input" id="ni-cp-input" placeholder="Search commands, orders, lines…" autocomplete="off" spellcheck="false">
          <button class="ni-cp-close-btn" id="ni-cp-close-btn" title="Close (Esc)">✕</button>
        </div>
        <div class="ni-cp-results" id="ni-cp-results"></div>
        <div class="ni-cp-footer">
          <span class="ni-cp-hint"><kbd>↑↓</kbd> ${t('ui.hint_navigate')}</span>
          <span class="ni-cp-hint"><kbd>↵</kbd> ${t('ui.hint_select')}</span>
          <span class="ni-cp-hint"><kbd>esc</kbd> ${t('ui.hint_close')}</span>
          <span class="ni-cp-index-count" id="ni-cp-index-count"></span>
          <div id="ni-lang-pill" title="${t('tip.lang_switcher')}">
            <span id="ni-lang-current">${LangSwitcher.current().toUpperCase()}</span>
            <span class="ni-lang-caret">▾</span>
            <div class="ni-lang-dropdown" id="ni-lang-dropdown">
              ${LangSwitcher._langs.map(l =>
                `<button class="ni-lang-opt${l.code === LangSwitcher.current() ? ' ni-lang-active' : ''}" data-lang="${l.code}">${l.label} — ${l.name}</button>`
              ).join('')}
            </div>
          </div>
          <div id="ni-dm-pill" title="${t('tip.toggle_light_dark')}">
            <span class="ni-dm-icon">☀️</span><span class="ni-dm-thumb"></span><span class="ni-dm-icon">🌙</span>
          </div>
        </div>`;
      document.body.appendChild(panel);
      CommandPalette._panel = panel;

      panel.querySelector('#ni-cp-close-btn').addEventListener('click', () => CommandPalette.close());
      const pill = panel.querySelector('#ni-dm-pill');
      if (DarkMode.isDark()) pill.classList.add('ni-dm-dark');
      pill.addEventListener('click', () => DarkMode.toggle());

      const langPill = panel.querySelector('#ni-lang-pill');
      const langDropdown = panel.querySelector('#ni-lang-dropdown');
      if (langPill) {
        langPill.addEventListener('click', e => {
          e.stopPropagation();
          langDropdown.classList.toggle('ni-lang-open');
        });
        langDropdown.querySelectorAll('.ni-lang-opt').forEach(btn => {
          btn.addEventListener('click', e => {
            e.stopPropagation();
            LangSwitcher.set(btn.dataset.lang);
          });
        });
        document.addEventListener('click', function(e) {
          if (!langPill.contains(e.target)) langDropdown.classList.remove('ni-lang-open');
        });
      }

      const input = panel.querySelector('#ni-cp-input');
      input.addEventListener('focus',  () => panel.classList.add('ni-cp-focused'));
      input.addEventListener('blur',   () => panel.classList.remove('ni-cp-focused'));
      input.addEventListener('input',  Util.debounce(() => CommandPalette._search(input.value), 60));
      input.addEventListener('keydown', e => {
        if (e.key === 'ArrowDown') { e.preventDefault(); CommandPalette._move(1); }
        if (e.key === 'ArrowUp')   { e.preventDefault(); CommandPalette._move(-1); }
        if (e.key === 'Enter')     { e.preventDefault(); CommandPalette._activate(); }
        if (e.key === 'Escape')    { CommandPalette.close(); }
      });
      document.addEventListener('mousedown', e => {
        if (CommandPalette.isOpen() && !panel.contains(e.target) && e.target !== fab)
          CommandPalette.close();
      });
    },

    _buildIndex() {
      const idx = [...CommandPalette._buildSelectionCommands()];
      for (const t of Store.tasksArr.slice(0, 2000)) {
        const order = t.ORDER || t.PRODUCTION_ORDER;
        const label = [t.text, order, t.MATERIAL_NUMBER].filter(Boolean).join(' · ');
        const sub   = `${t.PRODUCTION_LINE || '?'} · ${t.COLOR || ''}`.trim().replace(/·\s*$/, '');
        idx.push({
          type: 'order', label, sub, icon: '📦', id: t.id,
          run() {
            CommandPalette.close();
            NIMBUS.App.gotoGanttTimeline();
            setTimeout(() => {
              const task = NIMBUS.Store.tasks[t.id];
              if (task) { NIMBUS.Inspector.show(task); NIMBUS.Timeline.focus(String(t.id)); }
            }, 100);
          }
        });
      }
      const lines = [...new Set(Store.tasksArr.map(t => t.PRODUCTION_LINE).filter(Boolean))];
      for (const line of lines) {
        idx.push({
          type: 'line', label: `Go to: ${line}`, sub: 'Scroll Gantt to this line', icon: '🏭',
          run() {
            CommandPalette.close();
            NIMBUS.App.gotoGanttTimeline();
            const sample = NIMBUS.Store.tasksArr.find(t => t.PRODUCTION_LINE === line);
            if (sample) setTimeout(() => NIMBUS.Timeline.focus(String(sample.id)), 100);
          }
        });
        idx.push({
          type: 'line', label: `Isolate: ${line}`, sub: 'Show only this line in Gantt', icon: '⊕',
          run() {
            CommandPalette.close();
            NIMBUS.App.gotoGanttTimeline();
            NIMBUS.GanttFilter.isolateLine(line);
            NIMBUS.Timeline.rebuild?.();
            NIMBUS.Hierarchy.render?.();
          }
        });
      }
      idx.push(
        { type:'action', label:'Jump to First Conflict',  sub:'Scroll Gantt to nearest error alert', icon:'🚨',
          run(){
            CommandPalette.close();
            const err = (Store.alerts || []).filter(a => a.sev === 'err').sort((a,b) => a.time - b.time)[0];
            if (!err) { Toast.show(t('toast.no_conflicts_clean'), 'info', 1800); return; }
            NIMBUS.App.gotoGanttTimeline();
            setTimeout(() => { if (err.taskId) NIMBUS.Timeline.focus(String(err.taskId)); }, 100);
          } },
        { type:'action', label:'Take Snapshot',           sub:'Save a manual Time Machine checkpoint', icon:'📷',
          run(){
            CommandPalette.close();
            const label = `Manual · ${new Date().toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})}`;
            TimeMachine.snapshot(label);
            Toast.show(t('toast.snapshot_saved'), 'success', 1400);
          } },
        { type:'action', label:'Print / Export',          sub:'Open the print & export dialog',       icon:'🖨️',
          run(){ CommandPalette.close(); NIMBUS.Printer?.open?.(); } },
        { type:'action', label:'Go to Now',              sub:'Center Gantt on current time',           icon:'⊙',  run(){ CommandPalette.close(); NIMBUS.App.gotoGanttTimeline(); NIMBUS.Timeline.gotoNow?.(); } },
        { type:'action', label:'Time Machine',           sub:'Browse schedule history',                icon:'⏱', run(){ CommandPalette.close(); TimeMachine.openUI(); } },
        { type:'action', label:'Compare Schedules',      sub:'Diff current vs. a snapshot',           icon:'⇄',  run(){ CommandPalette.close(); Diff.showUI(); } },
        { type:'action', label:'Reload Data',            sub:'Re-read Excel (discards in-memory edits)', icon:'↺', run(){ CommandPalette.close(); NIMBUS.Persistence?.reload?.(); } }
      );
      CommandPalette._index = idx;
      const actionCt = idx.filter(i => i.type === 'action').length;
      const lineCt   = idx.filter(i => i.type === 'line'  ).length / 2;
      const orderCt  = idx.filter(i => i.type === 'order' ).length;
      const selCt    = idx.filter(i => i.type === 'selection').length;
      const countEl  = document.getElementById('ni-cp-index-count');
      if (countEl) {
        const selPart = selCt ? ` · ${selCt} selection` : '';
        countEl.textContent = `${actionCt} actions · ${Math.round(lineCt)} lines · ${orderCt} orders${selPart}`;
      }
    },

    _fuzzy(q, text) {
      const qt = q.toLowerCase(), tt = text.toLowerCase();
      if (tt.startsWith(qt)) return 3;
      if (tt.includes(qt))   return 2;
      let qi = 0;
      for (let i = 0; i < tt.length && qi < qt.length; i++)
        if (tt[i] === qt[qi]) qi++;
      return qi === qt.length ? 1 : 0;
    },

    _search(query) {
      if (!CommandPalette._index) CommandPalette._buildIndex();
      const q = query.trim();
      CommandPalette._lastQuery = q;

      // Intent mode: "need: ..." or "! ..."
      if (q.startsWith('need:') || q.startsWith('!')) {
        const intentText = q.replace(/^(need:|!)/, '').trim();
        if (intentText) {
          CommandPalette._results = NeedsEngine.resolveIntent(intentText);
          if (!CommandPalette._results.length) {
            CommandPalette._results = [{
              type: 'intent', icon: '💡',
              label: 'No match — try: "freeze", "compare", "rush order", "conflict"',
              sub: '', run() {}
            }];
          }
        } else {
          CommandPalette._results = [];
        }
        CommandPalette._cursor = 0;
        CommandPalette._render();
        return;
      }

      if (q) {
        // Fuzzy search across full index (includes selection commands)
        const typeOrder = { selection: 0, action: 1, line: 2, order: 3 };
        CommandPalette._results = CommandPalette._index
          .map(item => ({
            item,
            score: Math.max(
              CommandPalette._fuzzy(q, item.label),
              Math.floor(CommandPalette._fuzzy(q, item.sub || '') * 0.8)
            )
          }))
          .filter(x => x.score > 0)
          .sort((a, b) => b.score - a.score || (typeOrder[a.item.type] ?? 9) - (typeOrder[b.item.type] ?? 9))
          .slice(0, 9)
          .map(x => x.item);
      } else {
        // Empty query: Right Now → Selection → Actions
        const rightNow   = NeedsEngine.topNeeds(4);
        const selCmds    = CommandPalette._index.filter(i => i.type === 'selection');
        const rest = CommandPalette._index.filter(i => i.type === 'action');
        CommandPalette._results = [...rightNow, ...selCmds, ...rest];
      }
      CommandPalette._cursor = 0;
      CommandPalette._render();
    },

    _render() {
      const el = document.getElementById('ni-cp-results');
      if (!el) return;
      if (!CommandPalette._results.length) {
        el.innerHTML = `<div class="ni-cp-empty">${t('ui.no_results')}</div>`;
        return;
      }
      const q = CommandPalette._lastQuery;
      const labels = {
        action: 'Actions', line: 'Lines', order: 'Orders',
        need: 'Right Now', selection: 'With Selection', intent: 'Intent'
      };
      let html = '', lastSection = null;
      CommandPalette._results.forEach((r, i) => {
        const section = r.type;
        if (section !== lastSection) {
          const sectionLabel = labels[r.type] || r.type;
          const sectionCls = r.type === 'need' ? ' ni-cp-section--right-now' : '';
          const dot = r.type === 'need' ? '<span class="ni-cp-need-dot"></span>' : '';
          html += `<div class="ni-cp-section${sectionCls}">${dot}${sectionLabel}</div>`;
          lastSection = section;
        }
        html += `
          <div class="ni-cp-result${i === CommandPalette._cursor ? ' active' : ''}" data-idx="${i}">
            <span class="ni-cp-result-icon">${r.icon || '→'}</span>
            <div class="ni-cp-result-body">
              <span class="ni-cp-result-label">${CommandPalette._highlight(r.label, q)}</span>
              <span class="ni-cp-result-sub">${CommandPalette._esc(r.sub || '')}</span>
            </div>
            <span class="ni-cp-result-type" data-t="${r.type}">${r.type}</span>
          </div>`;
      });
      el.innerHTML = html;
      el.querySelectorAll('.ni-cp-result').forEach(row => {
        row.addEventListener('mousedown', e => { e.preventDefault(); CommandPalette._cursor = +row.dataset.idx; CommandPalette._activate(); });
      });
    },

    _move(dir) {
      if (!CommandPalette._results.length) return;
      CommandPalette._cursor = Math.max(0, Math.min(CommandPalette._results.length - 1, CommandPalette._cursor + dir));
      CommandPalette._render();
      document.querySelectorAll('.ni-cp-result')[CommandPalette._cursor]?.scrollIntoView?.({ block: 'nearest' });
    },

    _activate() {
      const item = CommandPalette._results[CommandPalette._cursor];
      if (item?.run) {
        if (item.type === 'action') CommandPalette._recent.push(item.label);
        try { item.run(); } catch (e) {
          (window.NIMBUS && window.NIMBUS.ErrorLog
            ? window.NIMBUS.ErrorLog.warn('intel', 'CommandPalette action failed', { err: String(e), errorCode: 'internal' })
            : console.warn('[CommandPalette]', e));
        }
      }
    },

    _esc(t) {
      return String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    },

    _highlight(text, q) {
      const safe = CommandPalette._esc(text);
      if (!q) return safe;
      const safeLo = safe.toLowerCase(), qLo = q.toLowerCase();
      const idx = safeLo.indexOf(qLo);
      if (idx !== -1)
        return safe.slice(0, idx) + '<mark>' + safe.slice(idx, idx + q.length) + '</mark>' + safe.slice(idx + q.length);
      let out = '', qi = 0;
      for (let i = 0; i < safe.length; i++) {
        if (qi < qLo.length && safeLo[i] === qLo[qi]) { out += `<mark>${safe[i]}</mark>`; qi++; }
        else out += safe[i];
      }
      return out;
    },

    _buildSelectionCommands() {
      const ids   = NIMBUS.Selection?.ids?.() || [];
      const n     = ids.length;
      if (!n) return [];

      const stats      = NIMBUS.Selection?.stats?.() || {};
      const fixedCount = stats.fixedCount || 0;
      const allFixed   = fixedCount === n;
      const cmds       = [];

      // Fix / Unfix
      cmds.push({
        type: 'selection',
        icon:  allFixed ? '🔓' : '🔒',
        label: allFixed ? `Unfix selected (${n})` : `Fix selected (${n})`,
        sub:   allFixed ? 'Make all selected orders moveable' : 'Pin all selected orders in place',
        run() {
          CommandPalette.close();
          const newFixed = !allFixed;
          NIMBUS.UndoStack?.push?.(`${newFixed ? 'Fix' : 'Unfix'} ${n} orders`, () => {});
          const validIds = ids.filter(id => Store.tasks[id]);
          if (validIds.length) Store.setFixed(validIds, newFixed, 'cmd-palette');
          Alerts.scheduleRecompute();
          Toast.show(newFixed ? t('toast.fixed_orders', { count: n }) : t('toast.unfixed_orders', { count: n }), 'success', 1400);
        }
      });

      // Push +1 hour
      cmds.push({
        type: 'selection',
        icon:  '⏩',
        label: `Push selected (${n}) forward 1 hour`,
        sub:   'Shift all selected orders +1h without opening edit modal',
        run() {
          CommandPalette.close();
          NIMBUS.UndoStack?.push?.(`Push ${n} orders +1h`, () => {});
          const patches = ids
            .filter(id => Store.tasks[id]?.start_date && Store.tasks[id]?.end_date)
            .map(id => {
              const t = Store.tasks[id];
              return { id, changes: {
                start_date: new Date(t.start_date.getTime() + 3600000),
                end_date:   new Date(t.end_date.getTime()   + 3600000),
              }};
            });
          if (patches.length) Store.updateMany(patches, 'cmd-palette');
          Alerts.scheduleRecompute();
          Toast.show(t('toast.pushed_orders', { count: n }), 'success', 1400);
        }
      });

      // Unschedule
      cmds.push({
        type: 'selection',
        icon:  '🗑️',
        label: `Unschedule selected (${n})`,
        sub:   'Remove start/end times from all selected orders',
        run() {
          CommandPalette.close();
          NIMBUS.UndoStack?.push?.(`Unschedule ${n} orders`, () => {});
          const unschPatches = ids.map(id => ({ id, changes: { start_date: null, end_date: null } }));
          if (unschPatches.length) Store.updateMany(unschPatches, 'cmd-palette');
          Alerts.scheduleRecompute();
          Toast.show(t('toast.unscheduled_bulk', { count: n }), 'success', 1400);
        }
      });

      // Snapshot before acting
      cmds.push({
        type: 'selection',
        icon:  '📸',
        label: `Snapshot before acting on selection (${n})`,
        sub:   'Save a Time Machine checkpoint now',
        run() {
          CommandPalette.close();
          const label = `Pre-selection · ${n} orders · ${new Date().toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' })}`;
          TimeMachine.snapshot(label);
          Toast.show('Snapshot saved', 'success', 1400);
        }
      });

      return cmds;
    },

    isOpen() { return CommandPalette._panel?.classList.contains('ni-cp-open'); },

    open() {
      if (!CommandPalette._panel) return;
      if (!CommandPalette._index) CommandPalette._buildIndex();
      CommandPalette._search('');
      CommandPalette._panel.classList.add('ni-cp-open');
      document.getElementById('ni-cmd-fab')?.classList.add('ni-fab-active');
      setTimeout(() => document.getElementById('ni-cp-input')?.focus(), 30);
    },

    close() {
      CommandPalette._panel?.classList.remove('ni-cp-open');
      document.getElementById('ni-cmd-fab')?.classList.remove('ni-fab-active');
      const inp = document.getElementById('ni-cp-input');
      if (inp) inp.value = '';
      CommandPalette._lastQuery = '';
    }
  };

  /* ==========================================================================
     TIME MACHINE — durable IndexedDB snapshot history
     ========================================================================== */
  const TimeMachine = {
    _snapshots: [],
    _panel:     null,

    init() {
      // Auto-snapshots are debounced (R20): a burst of undoable actions (drag-storm,
      // optimize + auto-reflow) used to deep-copy the ENTIRE task array and write
      // IndexedDB synchronously on EVERY UndoStack.push. Coalescing to one snapshot
      // ~1s after activity settles keeps that work off the hot push path. Manual
      // snapshot() calls (explicit checkpoints) stay immediate.
      TimeMachine._snapshotAuto = Util.debounce(
        label => TimeMachine.snapshot(label, { auto: true }), 1000
      );
      Store.subscribe(evt => {
        if (evt.type === 'undo:pushed') TimeMachine._snapshotAuto(evt.label);
      }, 'TimeMachine.autoSnapshot');
      Store.subscribe(evt => {
        if (['tasks:bulk','tasks:bulkUpdate'].includes(evt.type) &&
            evt.source !== 'undo' && evt.source !== 'time-machine') {
          TimeMachine._snapshotAuto(evt.type === 'tasks:bulk' ? 'Data loaded' : 'Bulk update');
        }
      });
      IntelDB.getAll('snapshots').then(rows => {
        TimeMachine._snapshots = (rows || []).sort((a, b) => a.ts - b.ts);
      });
    },

    snapshot(label, opts = {}) {
      const snap = {
        ts:    Date.now(),
        label: (label || 'Snapshot').substring(0, 80),
        auto:  !!opts.auto,
        plant: Store.selectedPlant || null,
        tasks: Store.tasksArr.map(t => ({
          id:               t.id,
          start_date:       t.start_date ? t.start_date.getTime() : null,
          end_date:         t.end_date   ? t.end_date.getTime()   : null,
          PRODUCTION_LINE:  t.PRODUCTION_LINE  || '',
          PRODUCTION_ORDER: t.PRODUCTION_ORDER || '',
          text:             t.text || t.MATERIAL_DESCRIPTION || '',
          COLOR:            t.COLOR     || '',
          FORM_SIZE:        t.FORM_SIZE || '',
          FIXED:            !!t.FIXED,
        }))
      };
      IntelDB.put('snapshots', snap).then(id => {
        snap.id = id || snap.id;
        TimeMachine._snapshots.push(snap);
        IntelDB.pruneSnapshots(200);
      }).catch(e => {
        (window.NIMBUS && window.NIMBUS.ErrorLog
          ? window.NIMBUS.ErrorLog.warn('intel', 'TimeMachine snapshot persist failed', { err: String(e), errorCode: 'internal' })
          : console.warn('[TimeMachine] snapshot persist failed', e));
      });
      return snap;
    },

    // Returns snapshots scoped to the currently selected plant.
    // Old snapshots lacking a plant field are excluded when a plant is selected
    // (they may belong to a different plant and we can't tell).
    _plantSnaps() {
      const p = Store.selectedPlant;
      if (!p) return TimeMachine._snapshots;
      return TimeMachine._snapshots.filter(s => s.plant === p);
    },

    _relTime(ts) {
      const m = Math.floor((Date.now() - ts) / 60000);
      if (m < 1)  return 'just now';
      if (m < 60) return `${m}m ago`;
      const h = Math.floor(m / 60);
      if (h < 24) return `${h}h${m % 60 ? ` ${m % 60}m` : ''} ago`;
      return new Date(ts).toLocaleDateString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
    },

    openUI() {
      if (!TimeMachine._panel) {
        const p = document.createElement('div');
        p.id = 'ni-tm-panel';
        p.className = 'ni-tm-panel';
        document.body.appendChild(p);
        TimeMachine._panel = p;
      }
      TimeMachine._panel.hidden = false;
      TimeMachine._renderPanel();
    },

    _renderPanel() {
      const p = TimeMachine._panel;
      if (!p) return;
      const snaps = TimeMachine._plantSnaps().slice(-60).reverse();
      p.innerHTML = `
        <div class="ni-tm-head">
          <span>⏱ Time Machine <span style="font-size:11px;color:var(--fg-mute)">${snaps.length} entries</span></span>
          <button class="ni-tm-close" id="ni-tm-close-btn">✕</button>
        </div>
        <div class="ni-tm-list">
          ${snaps.length ? snaps.map(s => `
            <div class="ni-tm-row">
              <span class="ni-tm-time">${TimeMachine._relTime(s.ts)}</span>
              <span class="ni-tm-label" title="${s.label}">${s.label}</span>
              <button class="ni-tm-restore-btn" data-ts="${s.ts}">Restore</button>
            </div>`).join('') : '<div style="padding:16px;font-size:12.5px;color:var(--fg-mute)">No snapshots yet. Actions will be recorded here.</div>'}
        </div>`;
      p.querySelector('#ni-tm-close-btn').onclick = () => { p.hidden = true; };
      p.querySelectorAll('.ni-tm-restore-btn').forEach(btn => {
        btn.addEventListener('click', () => TimeMachine.restore(+btn.dataset.ts));
      });
    },

    restore(ts) {
      const snap = TimeMachine._snapshots.find(s => s.ts === ts);
      if (!snap) { Toast.show(t('toast.snapshot_not_found'), 'error'); return; }
      const beforeSnap = UndoStack.snapshotTasks(Store.tasksArr.map(t => t.id));
      UndoStack._entries.push({ label: 'Before Time Machine restore', undoFn: () => UndoStack.restoreTasks(beforeSnap), at: Date.now() });
      const patches = snap.tasks
        .filter(s => Store.tasks[s.id])
        .map(s => ({
          id: s.id,
          changes: {
            start_date: s.start_date ? new Date(s.start_date) : null,
            end_date:   s.end_date   ? new Date(s.end_date)   : null
          }
        }));
      Store.updateMany(patches, 'time-machine');
      Alerts.scheduleRecompute();
      Toast.show(t('toast.restored', { label: snap.label, time: TimeMachine._relTime(ts) }), 'success', 3000);
      if (TimeMachine._panel) TimeMachine._panel.hidden = true;
    }
  };

  /* ==========================================================================
     CONFIDENCE — live schedule health score 0-100 + sparkline
     ========================================================================== */
  const Confidence = {
    _score:   100,
    _history: [],
    _badge:   null,
    _recomputeDebounced: null,

    init() {
      try { localStorage.removeItem('nimbus.confHistory'); } catch (e) {  // clear any previously persisted history
        (window.NIMBUS && window.NIMBUS.ErrorLog
          ? window.NIMBUS.ErrorLog.warn('intel', 'Confidence history clear failed', { err: String(e), errorCode: 'internal' })
          : console.warn('[Confidence] history clear failed', e));
      }
      Confidence._recomputeDebounced = Util.debounce(Confidence._recompute, 400);
      Confidence._injectBadge();
      Store.subscribe(evt => {
        if (evt?.type === 'plant:selected') {
          Confidence._history = [];
          Confidence._score   = 100;
          // Force the next _recompute past its skip-if-unchanged guard (R21): a plant
          // switch reset the badge above and must repaint it even if alerts/_rev match.
          Confidence._lastAlertsSrc = null;
          Confidence._lastRev = null;
          const scoreEl = document.getElementById('ni-conf-score');
          if (scoreEl) { scoreEl.textContent = '—'; scoreEl.style.color = ''; }
          // Vestigial: #ni-conf-spark no longer exists (sparkline retired for the
          // conic-gradient ring below) — this optional-chains to a no-op and is
          // left as dead code rather than removed (see task-5-report.md).
          const sparkCtx = document.getElementById('ni-conf-spark')?.getContext('2d');
          if (sparkCtx) sparkCtx.clearRect(0, 0, 48, 20);
          // Reset the ring to a neutral/empty state for the reset window — _score
          // is already forced to 100 above, so calling _updateRing() here would
          // briefly flash a full green ring before the debounced recompute below
          // repaints it with the real score (mirrors the old blank-canvas reset).
          const ring = document.getElementById('ni-conf-ring');
          if (ring) ring.style.background = 'var(--chrome-border)';
          Confidence._recomputeDebounced();
          return;
        }
        if (['tasks:bulk','tasks:bulkUpdate','task:update','task:remove'].includes(evt.type))
          Confidence._recomputeDebounced();
      });
      Store.subscribe(evt => {
        if (evt.type === 'alerts:change') Confidence._recomputeDebounced();
      }, 'Confidence.autoRecompute');
      setTimeout(Confidence._recompute, 600);
    },

    _injectBadge() {
      const actions = document.querySelector('.topbar-actions');
      if (!actions) return;
      const badge = document.createElement('div');
      badge.id = 'ni-conf-badge';
      badge.className = 'ni-conf-badge';
      badge.title = t('tip.schedule_confidence');
      badge.addEventListener('click', () => Confidence.showBreakdown());
      badge.innerHTML = `<span class="ni-conf-label">${t('ui.confidence_label')}</span>
        <span class="ni-conf-score" id="ni-conf-score">—</span>
        <span class="ni-conf-ring" id="ni-conf-ring"></span>`;
      actions.insertBefore(badge, actions.firstChild);
      Confidence._badge = badge;
      Confidence._updateRing();
    },

    async _recompute() {
      // Frozen during an optimizer preview trial or What-If sandbox session — neither
      // is committed yet, so the score/tracker must not react until Apply/Promote.
      if (NIMBUS.OptimizerPreview?.active || NIMBUS.Sandbox?.active) return;

      // Skip when neither alerts nor task data changed since the last score (R21):
      // _recompute fires on every alerts:change event and task mutation, and the
      // matrix build below is expensive. Store.alerts is reassigned on every change
      // (stable array identity) and Store.rev() bumps on every mutation, so this pair
      // fully captures the inputs. plant:selected nulls these to force a repaint.
      const alerts = Store.alerts || [];
      const rev = Store.rev();
      if (Confidence._lastAlertsSrc === alerts && Confidence._lastRev === rev) return;
      Confidence._lastAlertsSrc = alerts;
      Confidence._lastRev = rev;

      const tasks  = Store.tasksArr;
      if (!tasks.length) { Confidence._apply(100); return; }

      const hMinutes = (Store.userSettings?.confidenceHorizonMinutes ?? 20160);
      const horizonStart = new Date();
      const horizonEnd   = new Date(horizonStart.getTime() + hMinutes * 60000);

      // Days-out from now → time-weight multiplier (imminent = more costly)
      const tw = date => {
        if (!date) return 1.0;
        const d = (date - horizonStart) / 86400000;
        return d <= 3 ? 1.5 : d <= 7 ? 1.25 : 1.0;
      };

      // Factor 1: alert penalty — horizon-scoped, time-weighted, cap 50
      let alertPenalty = 0;
      alerts.forEach(a => {
        if (!a.time || a.time < horizonStart || a.time >= horizonEnd) return;
        const base = a.sev === 'err' ? 5 : a.sev === 'warn' ? 2 : 0;
        alertPenalty += base * tw(a.time);
      });
      alertPenalty = Math.min(50, Math.round(alertPenalty));

      // Factor 2: utilization overload across horizon, cap 20 — use worker when available
      let utilPenalty = 0;
      let matrix = null;
      const days = Math.ceil(hMinutes / 1440);
      const plant = Store.selectedPlant;
      const startMs = horizonStart.getTime();

      if (NIMBUS.Compute && NIMBUS.Compute.available() && plant) {
        try {
          const result = await NIMBUS.Compute.utilization(startMs, days);
          matrix = result.matrix;
          // Update the shared cache so subsequent sync calls can reuse it
          Utilization._cache = { key: `${startMs}|${days}|${rev}|${plant}`, matrix };
        } catch {
          // Fallback to synchronous compute
          matrix = Utilization.computeMatrix(horizonStart, days);
        }
      } else {
        // Worker not available; use sync compute and post for background refresh
        matrix = Utilization.computeMatrix(horizonStart, days);
        if (NIMBUS.Compute && NIMBUS.Compute.available() && plant) {
          NIMBUS.Compute.utilization(startMs, days)
            .then(({ matrix: m }) => {
              if (Store.rev() !== rev) return; // stale
              Utilization._cache = { key: `${startMs}|${days}|${rev}|${plant}`, matrix: m };
            })
            .catch(() => {});
        }
      }

      Object.values(matrix).forEach(lineData => {
        Object.values(lineData).forEach(row => {
          if (row.effectiveCapacity > 0 && row.scheduled > row.effectiveCapacity) utilPenalty += 1.5;
        });
      });
      utilPenalty = Math.min(20, Math.round(utilPenalty));

      Confidence._apply(Math.max(0, Math.min(100, 100 - alertPenalty - utilPenalty)));
    },

    _apply(score) {
      const prev = Confidence._score;
      Confidence._score = score;
      Confidence._history.push({ ts: Date.now(), score });
      if (Confidence._history.length > 500) Confidence._history.shift();

      const scoreEl = document.getElementById('ni-conf-score');
      if (scoreEl) {
        scoreEl.textContent = score;
        scoreEl.style.color = score >= 70 ? 'var(--ok)' : score >= 40 ? 'var(--warn-text)' : 'var(--err)';
      }
      const delta = score - prev;
      if (Confidence._badge && Math.abs(delta) >= 5) {
        const flash = document.createElement('span');
        flash.className = 'ni-conf-delta';
        flash.textContent = delta > 0 ? `+${delta}` : `${delta}`;
        flash.style.color = delta > 0 ? 'var(--ok)' : 'var(--err)';
        Confidence._badge.appendChild(flash);
        setTimeout(() => flash.remove(), 1900);
      }
      Confidence._updateRing();
    },

    // Pre-trial state for OptimizerPreview/Sandbox to roll back to on discard, so a
    // trial run never leaves a trace in the score or its history if it's thrown away.
    snapshot() {
      return { score: Confidence._score, history: Confidence._history.slice() };
    },

    restore(snap) {
      if (!snap) return;
      Confidence._score   = snap.score;
      Confidence._history = snap.history;
      const scoreEl = document.getElementById('ni-conf-score');
      if (scoreEl) {
        scoreEl.textContent = snap.score;
        scoreEl.style.color = snap.score >= 70 ? 'var(--ok)' : snap.score >= 40 ? 'var(--warn)' : 'var(--err)';
      }
      Confidence._updateRing();
    },

    // Conic-gradient ring — REPLACES the old canvas sparkline (_sparkline(),
    // retired; it drew into a #ni-conf-spark canvas that no longer exists).
    // Color thresholds are the exact mockup hex values, deliberately NOT the
    // --ok/--warn/--err tokens: the ring is a distinct, fixed-hex color
    // treatment from the breakdown popover's own chart (_drawChart below),
    // which DOES read those tokens. Do not cross the two.
    _updateRing() {
      const ring = document.getElementById('ni-conf-ring');
      if (!ring) return;
      const score = Math.max(0, Math.min(100, Confidence._score));
      const deg = (score / 100) * 360;
      const color = score >= 80 ? '#4ddb9f' : score >= 60 ? '#f0c04a' : '#f08a6a';
      ring.style.setProperty('--conf-color', color);
      ring.style.background = `conic-gradient(var(--conf-color) 0 ${deg}deg, var(--chrome-border) ${deg}deg 360deg)`;
    },

    // Shared CSS-custom-property reader (mirrors the Dashboard module's own
    // "_cssVar" helper over in schedule-workbench.mjs) so the breakdown
    // chart's ok/warn/err triad reads the real theme tokens instead of
    // duplicating hand-picked hex.
    _cssVar(name, fallback) {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    },
    _rgbTriplet(hex) {
      const h = String(hex).replace('#', '');
      return `${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)}`;
    },
    _rgba(hex, alpha) {
      return `rgba(${Confidence._rgbTriplet(hex)},${alpha})`;
    },

    async showBreakdown() {
      const alerts = Store.alerts || [];
      const hMinutes = (Store.userSettings?.confidenceHorizonMinutes ?? 20160);
      const hDays    = Math.ceil(hMinutes / 1440);
      const horizonStart = new Date();
      const horizonEnd   = new Date(horizonStart.getTime() + hMinutes * 60000);
      const tw = date => { if (!date) return 1.0; const d = (date - horizonStart) / 86400000; return d <= 3 ? 1.5 : d <= 7 ? 1.25 : 1.0; };

      const horizonAlerts = alerts.filter(a => a.time && a.time >= horizonStart && a.time < horizonEnd);
      const errCt  = horizonAlerts.filter(a => a.sev === 'err').length;
      const warnCt = horizonAlerts.filter(a => a.sev === 'warn').length;
      let alertPts = 0;
      horizonAlerts.forEach(a => { alertPts += (a.sev === 'err' ? 5 : a.sev === 'warn' ? 2 : 0) * tw(a.time); });
      alertPts = Math.min(50, Math.round(alertPts));

      // Fetch matrix using worker when available, fall back to sync
      let matrix = null;
      const startMs = horizonStart.getTime();
      const rev = Store.rev();
      const plant = Store.selectedPlant;

      if (NIMBUS.Compute && NIMBUS.Compute.available() && plant) {
        try {
          const result = await NIMBUS.Compute.utilization(startMs, hDays);
          matrix = result.matrix;
          Utilization._cache = { key: `${startMs}|${hDays}|${rev}|${plant}`, matrix };
        } catch {
          // Fallback to sync
          matrix = Utilization.computeMatrix(horizonStart, hDays);
        }
      } else {
        matrix = Utilization.computeMatrix(horizonStart, hDays);
      }
      const overloadedLines = {};
      Object.entries(matrix).forEach(([line, lineData]) => {
        let days = 0;
        Object.values(lineData).forEach(row => { if (row.effectiveCapacity > 0 && row.scheduled > row.effectiveCapacity) days++; });
        if (days > 0) overloadedLines[line] = days;
      });
      const overloadedCount = Object.keys(overloadedLines).length;
      const overloadedLineDays = Object.values(overloadedLines).reduce((s, d) => s + d, 0);
      const utilPts = Math.min(20, Math.round(overloadedLineDays * 1.5));

      const horizonEndLabel = horizonEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

      const _esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

      const tile = (count, label, sublabel, accent) => `
        <div class="ni-conf-tile">
          <div class="ni-conf-tile-num" style="color:${count > 0 ? accent : 'var(--fg-mute)'}">${count}</div>
          <div class="ni-conf-tile-lbl">${label}</div>
          <div class="ni-conf-tile-sub">${sublabel || '&nbsp;'}</div>
        </div>`;
      const tilesHtml = `
        <div class="ni-conf-tiles">
          ${tile(errCt,  errCt === 1 ? 'Critical conflict' : 'Critical conflicts', errCt ? `−${alertPts} pts` : '', 'var(--err)')}
          ${tile(warnCt, warnCt === 1 ? 'Warning' : 'Warnings', '', 'var(--warn)')}
          ${tile(overloadedCount, overloadedCount === 1 ? 'Overloaded line' : 'Overloaded lines',
                 overloadedCount ? `${overloadedLineDays} day${overloadedLineDays>1?'s':''} · −${utilPts} pts` : '', 'var(--warn)')}
        </div>`;

      const hasAny = errCt || warnCt || overloadedCount;
      const breakdownBlock = hasAny
        ? tilesHtml
        : `<p style="text-align:center;color:var(--fg-mute);font-size:12.5px;padding:14px 0;margin:0">Schedule looks healthy — no major issues detected.</p>`;

      const sortedAlerts = [...horizonAlerts].sort((a, b) => (a.time || 0) - (b.time || 0));
      const alertListHtml = sortedAlerts.length ? `
        <details class="ni-conf-alerts">
          <summary>
            <span class="ni-alerts-caret">▶</span>
            <span>Alerts in horizon (${sortedAlerts.length})</span>
          </summary>
          <div class="ni-conf-alerts-list">
            ${sortedAlerts.map(a => `
              <div class="ni-conf-row">
                <span class="ni-conf-dot" style="background:${a.sev==='err'?'var(--err)':'var(--warn)'}"></span>
                <span class="ni-conf-msg">${_esc(a.msg)}</span>
                <span class="ni-conf-date">${a.time ? a.time.toLocaleDateString('en-US',{month:'short',day:'numeric'}) : ''}</span>
                ${a.taskId ? `<button data-conf-goto="${_esc(a.id)}" class="ni-conf-goto" title="Go to" aria-label="Go to"><span class="ni-conf-goto-arrow">→</span><span class="ni-conf-goto-label">Go to</span></button>` : ''}
              </div>`).join('')}
          </div>
        </details>` : '';

      const cached = Confidence._history;
      const hasHistory = cached.length >= 2;
      const firstTs = hasHistory ? cached[0].ts : null;
      const startLabel = firstTs ? new Date(firstTs).toLocaleDateString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }) : '';

      const _sc = Confidence._score;
      // Verdict/threshold text triad — theme-driven via --ok/--warn/--err tokens
      // (read live via _cssVar) instead of the old hardcoded hex. This is a
      // separate color decision from the header ring's fixed mockup hex above.
      const _okC   = Confidence._cssVar('--ok',   '#1e7a4a');
      const _warnC = Confidence._cssVar('--warn', '#93610a');
      const _errC  = Confidence._cssVar('--err',  '#b02a20');
      const _tier = _sc >= 80 ? { label:'EXCELLENT', color:_okC,   bg:Confidence._rgba(_okC, 0.18)   }
                  : _sc >= 60 ? { label:'GOOD',      color:_okC,   bg:Confidence._rgba(_okC, 0.12)  }
                  : _sc >= 40 ? { label:'AT RISK',   color:_warnC, bg:Confidence._rgba(_warnC, 0.18)  }
                  :             { label:'CRITICAL',  color:_errC,  bg:Confidence._rgba(_errC, 0.18)    };

      const styleBlock = `
        <style>
          .ni-breakdown-dlg .ni-conf-body { padding:22px 24px; min-width:520px; max-width:580px; display:flex; flex-direction:column; gap:18px }
          .ni-breakdown-dlg .ni-conf-header { display:flex; justify-content:space-between; align-items:flex-start; gap:12px }
          .ni-breakdown-dlg .ni-conf-score-row { display:flex; align-items:baseline; gap:12px; flex-wrap:wrap }
          .ni-breakdown-dlg .ni-conf-score { font-size:30px; font-weight:700; line-height:1 }
          .ni-breakdown-dlg .ni-conf-score-max { font-size:13px; color:var(--fg-mute); font-weight:400; margin-left:2px }
          .ni-breakdown-dlg .ni-conf-tier { display:inline-block; font-size:10px; font-weight:700; padding:3px 10px; border-radius:10px; letter-spacing:.1em }
          .ni-breakdown-dlg .ni-conf-horizon { font-size:11px; color:var(--fg-mute); margin-top:6px }
          .ni-breakdown-dlg .ni-conf-close { background:none; border:none; cursor:pointer; font-size:18px; color:var(--fg-mute); padding:0; line-height:1 }
          .ni-breakdown-dlg .ni-conf-chart-wrap { position:relative }
          .ni-breakdown-dlg .ni-conf-chart-wrap canvas { width:100%; height:120px; display:block; border-radius:8px; background:var(--bg-subtle) }
          .ni-breakdown-dlg .ni-conf-chart-axis { display:flex; justify-content:space-between; margin-top:4px; font-size:9.5px; color:var(--fg-faint) }
          .ni-breakdown-dlg .ni-conf-tiles { display:grid; grid-template-columns:repeat(3,1fr); gap:8px }
          .ni-breakdown-dlg .ni-conf-tile { padding:10px 12px; border:1px solid var(--line); border-radius:8px; background:var(--bg-subtle); display:flex; flex-direction:column; gap:3px }
          .ni-breakdown-dlg .ni-conf-tile-num { font-size:22px; font-weight:700; line-height:1.1 }
          .ni-breakdown-dlg .ni-conf-tile-lbl { font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--fg-mute); font-weight:600 }
          .ni-breakdown-dlg .ni-conf-tile-sub { font-size:11px; color:var(--fg-mute) }
          .ni-breakdown-dlg .ni-conf-alerts { border-top:1px solid var(--line); padding-top:14px }
          .ni-breakdown-dlg .ni-conf-alerts summary { font-size:10.5px; font-weight:600; color:var(--fg-mute); text-transform:uppercase; letter-spacing:.05em; cursor:pointer; list-style:none; display:flex; align-items:center; gap:6px }
          .ni-breakdown-dlg .ni-conf-alerts summary::-webkit-details-marker { display:none }
          .ni-breakdown-dlg .ni-alerts-caret { display:inline-block; transition:transform .15s; font-size:9px }
          .ni-breakdown-dlg .ni-conf-alerts[open] .ni-alerts-caret { transform:rotate(90deg) }
          .ni-breakdown-dlg .ni-conf-alerts-list { max-height:220px; overflow-y:auto; display:flex; flex-direction:column; gap:4px; margin-top:8px }
          .ni-breakdown-dlg .ni-conf-row { display:flex; align-items:flex-start; gap:10px; padding:7px 10px; border-radius:6px; background:var(--bg-subtle) }
          .ni-breakdown-dlg .ni-conf-dot { flex-shrink:0; width:8px; height:8px; border-radius:50%; margin-top:6px }
          .ni-breakdown-dlg .ni-conf-msg { flex:1; font-size:12px; color:var(--fg); line-height:1.45 }
          .ni-breakdown-dlg .ni-conf-date { flex-shrink:0; font-size:10.5px; color:var(--fg-mute); white-space:nowrap; margin-top:3px }
          .ni-breakdown-dlg .ni-conf-goto { flex-shrink:0; padding:2px 8px; font-size:11px; border-radius:4px; border:1px solid var(--line); background:none; cursor:pointer; color:var(--fg-mute); white-space:nowrap; margin-top:1px; min-width:24px; text-align:center }
          .ni-breakdown-dlg .ni-conf-goto:hover { color:var(--fg); border-color:var(--fg-mute) }
          .ni-breakdown-dlg .ni-conf-goto-label { display:none }
          .ni-breakdown-dlg .ni-conf-goto:hover .ni-conf-goto-arrow { display:none }
          .ni-breakdown-dlg .ni-conf-goto:hover .ni-conf-goto-label { display:inline }
        </style>`;

      const dlg = document.createElement('dialog');
      dlg.className = 'ni-breakdown-dlg';
      dlg.innerHTML = `
        ${styleBlock}
        <div class="ni-conf-body">
          <div class="ni-conf-header">
            <div>
              <div class="ni-conf-score-row">
                <div><span class="ni-conf-score" style="color:${_tier.color}">${_sc}</span><span class="ni-conf-score-max">/100</span></div>
                <span class="ni-conf-tier" style="background:${_tier.bg};color:${_tier.color}">${_tier.label}</span>
              </div>
              <div class="ni-conf-horizon">Horizon: today – ${horizonEndLabel} (${hDays} days)</div>
            </div>
            <button onclick="this.closest('dialog').close()" class="ni-conf-close" aria-label="Close">✕</button>
          </div>
          ${hasHistory ? `
          <div class="ni-conf-chart-wrap">
            <canvas id="ni-conf-chart" width="760" height="240"></canvas>
            <div class="ni-conf-chart-axis"><span>${startLabel}</span><span>now</span></div>
          </div>` : ''}
          ${breakdownBlock}
          ${alertListHtml}
        </div>`;
      document.body.appendChild(dlg);
      try { dlg.showModal(); } catch { dlg.open = true; }
      if (hasHistory) Confidence._drawChart(dlg.querySelector('#ni-conf-chart'), cached);
      dlg.addEventListener('close', () => dlg.remove());
      dlg.addEventListener('click', e => {
        if (e.target === dlg) { dlg.close(); return; }
        const gotoBtn = e.target.closest('[data-conf-goto]');
        if (gotoBtn) { dlg.close(); if (typeof AlertsUIAdapter !== 'undefined') AlertsUIAdapter.focus(gotoBtn.dataset.confGoto); }
      });
    },

    _drawChart(canvas, history) {
      if (!canvas || history.length < 2) return;
      const W = canvas.width, H = canvas.height;
      const ctx = canvas.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      ctx.clearRect(0, 0, W, H);

      // Theme-driven ok/warn/err triad (read live via _cssVar) replacing the old
      // hardcoded #22c55e/#f59e0b/#ef4444 hex — same green/amber/red meaning,
      // now sourced from the real CSS tokens so dark mode resolves correctly.
      // Deliberately distinct from the header ring's fixed mockup hex (see
      // _updateRing above) — do not conflate the two color treatments.
      const okRgb   = Confidence._rgbTriplet(Confidence._cssVar('--ok',   '#1e7a4a'));
      const warnRgb = Confidence._rgbTriplet(Confidence._cssVar('--warn', '#93610a'));
      const errRgb  = Confidence._rgbTriplet(Confidence._cssVar('--err',  '#b02a20'));

      const yFor = v => H - (Math.max(0, Math.min(100, v)) / 100) * H;
      const xFor = i => history.length > 1 ? (i / (history.length - 1)) * W : W / 2;
      const ptColor = s => s >= 70 ? `rgb(${okRgb})` : s >= 40 ? `rgb(${warnRgb})` : `rgb(${errRgb})`;

      // Zone bands
      [{ from:0, to:40, color:`rgba(${errRgb},0.13)` },
       { from:40,to:70, color:`rgba(${warnRgb},0.10)` },
       { from:70,to:100,color:`rgba(${okRgb},0.10)` }
      ].forEach(b => {
        ctx.fillStyle = b.color;
        ctx.fillRect(0, yFor(b.to), W, yFor(b.from) - yFor(b.to));
      });

      // Zone labels (right-aligned, faint)
      ctx.font = `bold ${Math.round(14/dpr)}px system-ui`; ctx.textAlign = 'right';
      [{ y: yFor(20), label:'CRITICAL', color:`rgba(${errRgb},0.45)` },
       { y: yFor(55), label:'AT RISK',  color:`rgba(${warnRgb},0.4)` },
       { y: yFor(85), label:'GOOD',     color:`rgba(${okRgb},0.4)`  }
      ].forEach(({ y, label, color }) => { ctx.fillStyle = color; ctx.fillText(label, W - 6, y + 5); });

      // Reference lines at 40 and 70
      [[40,`rgba(${errRgb},0.55)`],[70,`rgba(${okRgb},0.55)`]].forEach(([v,col]) => {
        ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.setLineDash([5,4]);
        ctx.beginPath(); ctx.moveTo(0, yFor(v)); ctx.lineTo(W, yFor(v)); ctx.stroke();
      });
      ctx.setLineDash([]);

      // Y-axis score labels
      ctx.font = `${Math.round(18/dpr)}px system-ui`; ctx.textAlign = 'left';
      [[40,`rgba(${errRgb},0.65)`],[70,`rgba(${okRgb},0.65)`]].forEach(([v,col]) => {
        ctx.fillStyle = col; ctx.fillText(v, 4, yFor(v) - 3);
      });

      // Pre-compute point positions
      const pts = history.map((p, i) => ({ x: xFor(i), y: yFor(p.score), score: p.score, ts: p.ts }));
      const last = history[history.length - 1].score;
      const lineColor = ptColor(last);
      const fillColor = last >= 70 ? `rgba(${okRgb},0.22)` : last >= 40 ? `rgba(${warnRgb},0.22)` : `rgba(${errRgb},0.22)`;

      // Filled area under line
      ctx.beginPath();
      pts.forEach((p,i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
      ctx.lineTo(pts[pts.length-1].x, H); ctx.lineTo(0, H);
      ctx.closePath(); ctx.fillStyle = fillColor; ctx.fill();

      // Score line with glow
      ctx.shadowColor = lineColor; ctx.shadowBlur = 6;
      ctx.beginPath(); ctx.strokeStyle = lineColor; ctx.lineWidth = 3; ctx.lineJoin = 'round';
      pts.forEach((p,i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Dot at every data point
      pts.forEach((p, i) => {
        const isLast = i === pts.length - 1;
        const col = ptColor(p.score);
        if (isLast) { ctx.shadowColor = col; ctx.shadowBlur = 12; }
        ctx.beginPath();
        ctx.arc(p.x, p.y, isLast ? 6 : 3, 0, Math.PI * 2);
        ctx.fillStyle = col; ctx.fill();
        ctx.strokeStyle = isLast ? '#fff' : '#1a1b1f'; ctx.lineWidth = isLast ? 2.5 : 1.5; ctx.stroke();
        if (isLast) ctx.shadowBlur = 0;
      });

      // Hover tooltip — position:fixed so it can overflow the dialog bounds
      const tip = document.createElement('div');
      tip.style.cssText = [
        'position:fixed','pointer-events:none','display:none',
        'padding:5px 10px','border-radius:5px','font-size:12px','font-weight:600',
        'white-space:nowrap','z-index:99999','transform:translate(-50%,-100%) translateY(-10px)',
        'background:var(--bg-elev,#1e1f24)',
        'border:1px solid var(--line,#35363d)',
        'color:var(--fg,#e8e9ee)',
        'box-shadow:0 3px 12px rgba(0,0,0,0.45)',
      ].join(';');
      (canvas.closest('dialog') || document.body).appendChild(tip);

      canvas.style.cursor = 'crosshair';
      canvas.addEventListener('mousemove', e => {
        const rect = canvas.getBoundingClientRect();
        const mx = (e.clientX - rect.left) * (W / rect.width);
        const my = (e.clientY - rect.top)  * (H / rect.height);
        let nearest = null, minDist = Infinity;
        pts.forEach(p => {
          const d = Math.hypot(p.x - mx, p.y - my);
          if (d < minDist) { minDist = d; nearest = p; }
        });
        const threshold = 28 * (W / rect.width);
        if (nearest && minDist < threshold) {
          const col = `color:${ptColor(nearest.score)}`;
          const timeStr = nearest.ts
            ? new Date(nearest.ts).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})
            : '';
          const dateStr = nearest.ts
            ? new Date(nearest.ts).toLocaleDateString('en-US',{month:'short',day:'numeric'})
            : '';
          tip.innerHTML = `<span style="${col};margin-right:5px">●</span>`
            + `<strong style="${col}">${nearest.score}</strong>`
            + (timeStr ? `<span style="color:var(--fg-mute);font-size:10.5px;margin-left:6px">${dateStr} ${timeStr}</span>` : '');
          tip.style.display = 'block';
          tip.style.left = `${rect.left + nearest.x * (rect.width / W)}px`;
          tip.style.top  = `${rect.top  + nearest.y * (rect.height / H)}px`;
        } else {
          tip.style.display = 'none';
        }
      });
      canvas.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
      canvas.closest('dialog')?.addEventListener('close', () => tip.remove(), { once: true });
    }
  };

  /* Alert-cell highlights are now native vis-timeline background items, built
     inside Timeline.rebuild() (app.js). This module was a canvas overlay that
     couldn't layer correctly behind foreground items — removed in favor of the
     library's native .vis-background channel. Cleanup any stale canvas the old
     version may have left in the DOM. */
  (function _cleanupLegacyAlertCanvas() {
    document.querySelectorAll('#ni-alert-cells, #ni-stress-canvas').forEach(n => n.remove());
  })();

  /* ==========================================================================
     RIPPLE PREVIEW — Alt+hover shows downstream task shift ghosts
     ========================================================================== */
  const RipplePreview = {
    _active: false,
    _ghosts: [],
    _lastId: null,
    _debouncedShow: null,

    init() {
      RipplePreview._debouncedShow = Util.debounce(RipplePreview._show, 80);
      document.addEventListener('keydown', e => {
        if (e.altKey && !RipplePreview._active) {
          RipplePreview._active = true;
          document.getElementById('vis-timeline')?.classList.add('ripple-mode');
        }
      });
      document.addEventListener('keyup', e => {
        if (!e.altKey) {
          RipplePreview._active = false;
          RipplePreview._clearGhosts();
          document.getElementById('vis-timeline')?.classList.remove('ripple-mode');
          RipplePreview._lastId = null;
        }
      });
      // Window losing focus (e.g. Alt+Tab) suppresses keyup, leaving the
      // crosshair cursor stuck on. Force-clear ripple state on blur/hide.
      const _clearRipple = () => {
        RipplePreview._active = false;
        RipplePreview._clearGhosts();
        document.getElementById('vis-timeline')?.classList.remove('ripple-mode');
        RipplePreview._lastId = null;
      };
      window.addEventListener('blur', _clearRipple);
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) _clearRipple();
      });
      const gantt = document.getElementById('vis-timeline');
      if (!gantt) return;
      gantt.addEventListener('mouseover', e => {
        if (!RipplePreview._active) return;
        const item = e.target.closest?.('.vis-item');
        if (!item) { RipplePreview._clearGhosts(); return; }
        const id = item.getAttribute('data-id');
        if (id && id !== RipplePreview._lastId) {
          RipplePreview._lastId = id;
          RipplePreview._debouncedShow(id);
        }
      });
    },

    _show(taskId) {
      RipplePreview._clearGhosts();
      const task = Store.tasks[taskId];
      if (!task?.PRODUCTION_LINE || !task.start_date) return;
      const line = task.PRODUCTION_LINE;
      const peers = Store.tasksArr
        .filter(t => t.PRODUCTION_LINE === line && t.start_date && t.id !== taskId)
        .sort((a,b) => a.start_date - b.start_date);
      const downstream = peers.filter(t => t.start_date >= task.start_date).slice(0, 5);
      if (!downstream.length) return;

      downstream.forEach((t, i) => {
        const el = document.querySelector(`.vis-item[data-id="${t.id}"]`);
        if (!el) return;
        const r = el.getBoundingClientRect();
        if (!r.width) return;
        const ghost = document.createElement('div');
        ghost.className = 'ni-ripple-ghost';
        ghost.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;
          border-radius:3px;pointer-events:none;z-index:9998;box-sizing:border-box;
          opacity:${0.75 - i * 0.1};`;
        ghost.title = `Downstream: ${t.text || t.id}`;
        document.body.appendChild(ghost);
        RipplePreview._ghosts.push(ghost);
      });
    },

    _clearGhosts() {
      RipplePreview._ghosts.forEach(g => g.remove());
      RipplePreview._ghosts = [];
    }
  };

  /* ==========================================================================
     DIFF — compare two schedule snapshots visually
     ========================================================================== */
  const Diff = {
    _fmtDate(ms) {
      if (!ms) return '—';
      const d = new Date(ms);
      return d.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' })
        + ' ' + d.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' });
    },

    _fmtShort(ms) {
      if (!ms) return '—';
      const d = new Date(ms);
      return d.toLocaleDateString('en-US', { month:'short', day:'numeric' })
        + ' · ' + d.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' });
    },

    _fmtDelta(ms) {
      const h = ms / 3600000;
      const sign = h > 0 ? '+' : '';
      if (Math.abs(h) < 1) return `${sign}${Math.round(h * 60)}m`;
      return `${sign}${h.toFixed(1)}h`;
    },

    // Enrich a raw snapshot task with live Store data (stable IDs make this safe)
    _enrich(t) {
      const live = Store.tasks[t.id];
      return {
        id:               t.id,
        start_date:       t.start_date,
        end_date:         t.end_date,
        PRODUCTION_LINE:  t.PRODUCTION_LINE  || '',
        PRODUCTION_ORDER: t.PRODUCTION_ORDER || live?.PRODUCTION_ORDER || t.id.slice(0, 8),
        text:             t.text             || live?.text              || live?.MATERIAL_DESCRIPTION || '—',
        COLOR:            t.COLOR            || live?.COLOR             || '',
        FORM_SIZE:        t.FORM_SIZE        || live?.FORM_SIZE         || '',
        FIXED:            t.FIXED            ?? live?.FIXED             ?? false,
      };
    },

    compute(snapTasksA, snapTasksB) {
      const mapA = {}, mapB = {};
      (snapTasksA || []).forEach(t => { mapA[t.id] = Diff._enrich(t); });
      (snapTasksB || []).forEach(t => { mapB[t.id] = Diff._enrich(t); });

      const added   = Object.keys(mapB).filter(id => !mapA[id]).map(id => mapB[id]);
      const removed = Object.keys(mapA).filter(id => !mapB[id]).map(id => mapA[id]);
      const moved   = [];
      Object.keys(mapB).forEach(id => {
        if (!mapA[id]) return;
        const delta       = (mapB[id].start_date || 0) - (mapA[id].start_date || 0);
        const lineChanged = mapA[id].PRODUCTION_LINE !== mapB[id].PRODUCTION_LINE;
        if (Math.abs(delta) > 0 || lineChanged) {
          moved.push({
            ...mapB[id],
            delta,
            lineFrom:    mapA[id].PRODUCTION_LINE,
            lineTo:      mapB[id].PRODUCTION_LINE,
            lineChanged,
            newStart:    mapB[id].start_date,
            oldStart:    mapA[id].start_date,
          });
        }
      });
      moved.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

      // Line-level summary
      const lineImpact = {};
      const bump = (line, key) => {
        if (!line) return;
        lineImpact[line] = lineImpact[line] || { moved:0, added:0, removed:0 };
        lineImpact[line][key]++;
      };
      moved.forEach(m => { bump(m.lineTo, 'moved'); if (m.lineChanged) bump(m.lineFrom, 'moved'); });
      added.forEach(a => bump(a.PRODUCTION_LINE, 'added'));
      removed.forEach(r => bump(r.PRODUCTION_LINE, 'removed'));

      return {
        moved, added, removed, lineImpact,
        summary: `${moved.length} moved · ${added.length} added · ${removed.length} removed`,
      };
    },

    _renderResults(d) {
      const esc = s => String(s || '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

      const statStrip = `
        <div class="ni-diff-stat-strip">
          <div class="ni-diff-stat moved">
            <div class="ni-diff-stat-num">${d.moved.length}</div>
            <div class="ni-diff-stat-lbl">Rescheduled</div>
          </div>
          <div class="ni-diff-stat added">
            <div class="ni-diff-stat-num">${d.added.length}</div>
            <div class="ni-diff-stat-lbl">Added</div>
          </div>
          <div class="ni-diff-stat removed">
            <div class="ni-diff-stat-num">${d.removed.length}</div>
            <div class="ni-diff-stat-lbl">Removed</div>
          </div>
        </div>`;

      const rowMoved = d.moved.map(m => {
        const dir   = m.delta > 0 ? 'later' : 'earlier';
        const arrow = m.delta > 0 ? '▶' : '◀';
        const linePart = m.lineChanged
          ? `<span class="ni-diff-line-chip">${esc(m.lineFrom)}</span><span style="color:var(--fg-mute);margin:0 3px">→</span><span class="ni-diff-line-chip">${esc(m.lineTo)}</span>`
          : `<span class="ni-diff-line-chip">${esc(m.lineTo)}</span>`;
        const wasStr = Diff._fmtShort(m.oldStart);
        const nowStr = Diff._fmtShort(m.newStart);
        return `<div class="ni-diff-row ni-diff-row-moved">
          <div class="ni-diff-row-top">
            <span class="ni-diff-po">${esc(m.PRODUCTION_ORDER)}</span>
            <span class="ni-diff-desc">${esc(m.text)}</span>
            <span class="ni-diff-shift ${dir}">${arrow} ${esc(Diff._fmtDelta(m.delta))}</span>
          </div>
          <div class="ni-diff-row-bottom">
            ${linePart}
            <span class="ni-diff-dates">Was: ${esc(wasStr)} → Now: ${esc(nowStr)}</span>
          </div>
        </div>`;
      }).join('');

      const rowAdded = d.added.map(a => `
        <div class="ni-diff-row ni-diff-row-added">
          <div class="ni-diff-row-top">
            <span class="ni-diff-po">${esc(a.PRODUCTION_ORDER)}</span>
            <span class="ni-diff-desc">${esc(a.text)}</span>
            <span class="ni-diff-shift added">+ Added</span>
          </div>
          <div class="ni-diff-row-bottom">
            <span class="ni-diff-line-chip">${esc(a.PRODUCTION_LINE)}</span>
            ${a.start_date ? `<span class="ni-diff-dates">${esc(Diff._fmtShort(a.start_date))}</span>` : ''}
          </div>
        </div>`).join('');

      const rowRemoved = d.removed.map(r => `
        <div class="ni-diff-row ni-diff-row-removed">
          <div class="ni-diff-row-top">
            <span class="ni-diff-po">${esc(r.PRODUCTION_ORDER)}</span>
            <span class="ni-diff-desc">${esc(r.text)}</span>
            <span class="ni-diff-shift removed">− Removed</span>
          </div>
          <div class="ni-diff-row-bottom">
            <span class="ni-diff-line-chip">${esc(r.PRODUCTION_LINE)}</span>
            ${r.start_date ? `<span class="ni-diff-dates">${esc(Diff._fmtShort(r.start_date))}</span>` : ''}
          </div>
        </div>`).join('');

      const lineLines = Object.entries(d.lineImpact)
        .sort((a,b) => (b[1].moved+b[1].added+b[1].removed) - (a[1].moved+a[1].added+a[1].removed))
        .map(([line, ct]) => {
          const parts = [];
          if (ct.moved)   parts.push(`${ct.moved} moved`);
          if (ct.added)   parts.push(`${ct.added} added`);
          if (ct.removed) parts.push(`${ct.removed} removed`);
          return `<strong>${esc(line)}:</strong> ${parts.join(', ')}`;
        }).join(' &nbsp;·&nbsp; ');

      return `
        ${statStrip}
        ${lineLines ? `<div class="ni-diff-line-summary">${lineLines}</div>` : ''}
        ${d.moved.length   ? `<div class="ni-diff-section-hd">Rescheduled <span class="ni-diff-section-ct">${d.moved.length}</span></div>${rowMoved}` : ''}
        ${d.added.length   ? `<div class="ni-diff-section-hd">Added to schedule <span class="ni-diff-section-ct">${d.added.length}</span></div>${rowAdded}` : ''}
        ${d.removed.length ? `<div class="ni-diff-section-hd">Removed from schedule <span class="ni-diff-section-ct">${d.removed.length}</span></div>${rowRemoved}` : ''}
        ${!d.moved.length && !d.added.length && !d.removed.length
          ? '<div style="color:var(--fg-mute);font-size:12.5px;padding:8px 0">No differences — schedules are identical.</div>' : ''}`;
    },

    showUI() {
      const snaps = TimeMachine._plantSnaps();
      if (snaps.length < 2) { Toast.show(t('toast.need_2_snapshots'), 'warn'); return; }

      const dlg = document.createElement('dialog');
      dlg.className = 'ni-diff-dlg';

      const snapRows = snaps.slice(-40).reverse().map((s, i) => {
        const badge = s.auto
          ? '<span class="ni-diff-snap-badge auto">auto</span>'
          : '<span class="ni-diff-snap-badge manual">manual</span>';
        const taskCt = s.tasks?.length ? `${s.tasks.length} orders` : '';
        return `<div class="ni-diff-snap-row${i === 0 ? ' ni-diff-snap-sel' : ''}" data-ts="${s.ts}">
          <span class="ni-diff-snap-ago">${TimeMachine._relTime(s.ts)}</span>
          <span class="ni-diff-snap-lbl" title="${s.label}">${s.label}</span>
          <span style="display:flex;gap:5px;align-items:center">
            <span style="font-size:10px;color:var(--fg-mute)">${taskCt}</span>
            ${badge}
          </span>
        </div>`;
      }).join('');

      dlg.innerHTML = `
        <div style="padding:20px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
            <h3 style="margin:0;font-size:14px;font-weight:700">⇄ Compare Schedules</h3>
            <button id="ni-diff-close" style="background:none;border:none;cursor:pointer;font-size:16px;color:var(--fg-mute);padding:2px 6px">✕</button>
          </div>
          <div style="font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--fg-mute);margin-bottom:6px">Compare current schedule against:</div>
          <div class="ni-diff-snaplist" id="ni-diff-snaplist">${snapRows}</div>
          <div class="ni-diff-results" id="ni-diff-out">
            <div style="color:var(--fg-mute);font-size:12.5px;padding:8px 0">Select a snapshot above to compare.</div>
          </div>
          <div style="margin-top:14px;text-align:right">
            <button class="btn btn-ghost sm" id="ni-diff-close2">Close</button>
          </div>
        </div>`;

      document.body.appendChild(dlg);
      try { dlg.showModal(); } catch { dlg.open = true; }
      dlg.addEventListener('close', () => dlg.remove());
      dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
      dlg.querySelector('#ni-diff-close').addEventListener('click',  () => dlg.close());
      dlg.querySelector('#ni-diff-close2').addEventListener('click', () => dlg.close());

      const runDiff = ts => {
        const snap = snaps.find(s => s.ts === ts);
        if (!snap) return;
        const curr = Store.tasksArr.map(t => ({
          id:               t.id,
          start_date:       t.start_date?.getTime?.() || null,
          end_date:         t.end_date?.getTime?.()   || null,
          PRODUCTION_LINE:  t.PRODUCTION_LINE  || '',
          PRODUCTION_ORDER: t.PRODUCTION_ORDER || '',
          text:             t.text || t.MATERIAL_DESCRIPTION || '',
          COLOR:            t.COLOR    || '',
          FORM_SIZE:        t.FORM_SIZE || '',
          FIXED:            !!t.FIXED,
        }));
        const d = Diff.compute(snap.tasks, curr);
        document.getElementById('ni-diff-out').innerHTML = Diff._renderResults(d);
      };

      // Wire up snapshot row clicks
      dlg.querySelectorAll('.ni-diff-snap-row').forEach(row => {
        row.addEventListener('click', () => {
          dlg.querySelectorAll('.ni-diff-snap-row').forEach(r => r.classList.remove('ni-diff-snap-sel'));
          row.classList.add('ni-diff-snap-sel');
          runDiff(+row.dataset.ts);
        });
      });

      // Auto-run on the first (most recent) snapshot
      const firstTs = snaps.slice(-40).reverse()[0]?.ts;
      if (firstTs) runDiff(firstTs);
    }
  };

  /* ==========================================================================
     PATTERNS — heuristic sequence-pair learning from drags
     ========================================================================== */
  const Patterns = {
    _LS_KEY:    'nimbus.patterns.v1',
    _pairs:     {},
    _THRESHOLD: 4,

    init() {
      try { Patterns._pairs = JSON.parse(localStorage.getItem(Patterns._LS_KEY) || '{}'); } catch {}
      Store.subscribe(evt => {
        if (evt.type === 'task:update' && evt.source === 'timeline' && evt.changes?.start_date)
          Patterns._observe(evt.id);
      });
    },

    _observe(movedId) {
      const task = Store.tasks[movedId];
      if (!task?.PRODUCTION_LINE || !task.start_date) return;
      const sorted = Store.tasksArr
        .filter(x => x.PRODUCTION_LINE === task.PRODUCTION_LINE && x.start_date)
        .sort((a,b) => a.start_date - b.start_date);
      const idx = sorted.findIndex(x => x.id === movedId);
      if (idx > 0) {
        const prev = sorted[idx - 1];
        const key  = `${Util.norm(prev.COLOR)}→${Util.norm(task.COLOR)}`;
        Patterns._pairs[key] = (Patterns._pairs[key] || 0) + 1;
        localStorage.setItem(Patterns._LS_KEY, JSON.stringify(Patterns._pairs));
        if (Patterns._pairs[key] === Patterns._THRESHOLD)
          Toast.show(t('toast.pattern_detected', { key }), 'info', 4500);
      }
    },

    getSuggestions() {
      return Object.entries(Patterns._pairs)
        .filter(([,c]) => c >= Patterns._THRESHOLD)
        .sort((a,b) => b[1] - a[1])
        .map(([key, count]) => ({ key, count }));
    }
  };



  /* ==========================================================================
     EXPOSE + BOOT
     ========================================================================== */
  /* ==========================================================================
     DARK MODE — token swap via body.dark; persisted in localStorage.
     ========================================================================== */
  const DarkMode = {
    _key: 'nimbus.theme',

    // Resolve the effective theme: an explicit per-user (or role) 'theme' pref wins;
    // otherwise fall back to the offline nimbus.theme cache (Store not yet hydrated
    // at first boot / pre-network). Mirrors Store.pref precedence without inventing a
    // default so a missing pref keeps deferring to the offline cache.
    _resolve() {
      try {
        const us = Store && Store.userSettings;
        const rd = Store && Store.roleDefaults;
        if (us && us.theme != null) return us.theme;
        if (rd && rd.theme != null) return rd.theme;
      } catch { /* Store not ready — fall through to offline cache */ }
      return localStorage.getItem(DarkMode._key);
    },

    init() {
      document.body.classList.toggle('dark', DarkMode._resolve() === 'dark');
      DarkMode._syncPill();
    },

    _syncPill() {
      const pill = document.getElementById('ni-dm-pill');
      if (!pill) return;
      pill.classList.toggle('ni-dm-dark', DarkMode.isDark());
    },

    // Apply a specific theme with write-through: body.dark + the offline nimbus.theme
    // cache (so the pre-network boot picks the right theme) + the durable per-user
    // pref via Session.setPref. Used by both the header pill and the settings control.
    set(isDark, opts = {}) {
      document.body.classList.toggle('dark', !!isDark);
      try { localStorage.setItem(DarkMode._key, isDark ? 'dark' : 'light'); } catch {}
      try { NIMBUS.Session && NIMBUS.Session.setPref && NIMBUS.Session.setPref('theme', isDark ? 'dark' : 'light'); } catch {}
      DarkMode._syncPill();
      if (opts.toast !== false)
        Toast.show(isDark ? t('toast.dark_mode_on') : t('toast.light_mode_on'), 'info', 1200);
      // Repaint canvas-painted views whose colors are baked in at draw time.
      try { NIMBUS.TimelineNav?.render?.(); } catch (e) {
        (window.NIMBUS && window.NIMBUS.ErrorLog
          ? window.NIMBUS.ErrorLog.warn('intel', 'DarkMode TimelineNav repaint failed', { err: String(e), errorCode: 'internal' })
          : console.warn('[DarkMode] TimelineNav repaint failed', e));
      }
      try { NIMBUS.Dashboard?._renderHeatmap?.(); } catch (e) {
        (window.NIMBUS && window.NIMBUS.ErrorLog
          ? window.NIMBUS.ErrorLog.warn('intel', 'DarkMode heatmap repaint failed', { err: String(e), errorCode: 'internal' })
          : console.warn('[DarkMode] heatmap repaint failed', e));
      }
    },

    toggle() { DarkMode.set(!DarkMode.isDark()); },

    isDark() { return document.body.classList.contains('dark'); }
  };

  const LangSwitcher = {
    _key: 'nimbus.locale',
    _langs: [
      { code: 'en', label: 'EN', name: 'English'   },
      { code: 'es', label: 'ES', name: 'Español'   },
      { code: 'fr', label: 'FR', name: 'Français'  },
      { code: 'de', label: 'DE', name: 'Deutsch'   },
      { code: 'pt', label: 'PT', name: 'Português' },
    ],
    current() { return localStorage.getItem(LangSwitcher._key) || 'en'; },
    async set(code) {
      // Offline render cache — the pre-network boot reads this before Store is
      // hydrated, so it must reflect the new locale immediately.
      try { localStorage.setItem(LangSwitcher._key, code); } catch {}
      // Durable per-user pref. Await an explicit flush BEFORE reload: setPref is
      // debounced and the reload would otherwise cancel the pending PATCH, leaving
      // the DB (and session cache) stale and reverting the language on next boot.
      try {
        if (NIMBUS.Session && NIMBUS.Session.setPref) {
          NIMBUS.Session.setPref('language', code);
          if (NIMBUS.Session.flushPrefs) await NIMBUS.Session.flushPrefs();
        }
      } catch { /* best-effort — the offline cache above still applies the locale */ }
      location.reload();
    },
  };

  Object.assign(NIMBUS, {
    NeedsEngine,
    CommandPalette,
    TimeMachine,
    Confidence,
    RipplePreview,
    Diff,
    LangSwitcher,
    Patterns,
    DarkMode
  });

  function _boot() {
    DarkMode.init();
    NeedsEngine.init();
    IntelDB.open().then(() => {
      CommandPalette.init();
      TimeMachine.init();
      Confidence.init();
      Patterns.init();
      setTimeout(() => { RipplePreview.init(); }, 220);
    }).catch(e => {
      (window.NIMBUS && window.NIMBUS.ErrorLog
        ? window.NIMBUS.ErrorLog.warn('intel', 'IndexedDB unavailable — continuing without persistence.', { err: String(e), errorCode: 'internal' })
        : console.warn('[NIMBUS.Intelligence] IndexedDB unavailable — continuing without persistence.', e));
      CommandPalette.init();
      TimeMachine._snapshots = [];
      TimeMachine.init(); // wires the undo:pushed subscription; must run even without IDB
      Confidence.init();
      Patterns.init();
      setTimeout(() => { RipplePreview.init(); }, 220);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _boot);
  } else {
    _boot();
  }

})();
