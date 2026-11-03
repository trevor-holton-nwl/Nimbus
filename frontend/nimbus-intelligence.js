/* =============================================================================
   N.I.M.B.U.S. Intelligence Layer  (nimbus-intelligence.js)
   Loaded after app.js — extends window.NIMBUS with 10 intelligence modules.

   Modules:
     IntelDB         — IndexedDB store backing history/patterns
     NeedsEngine     — "needs attention" suggestions
     DarkMode        — theme toggle
     LangSwitcher    — language selector
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

  // One clock (I13): the plant's "now" / start of today, the same helpers the Dashboard uses. Read late-bound per call
  // (the `NIMBUS.Engine?.` idiom below) so the legacy-surface ratchet does not grow; the fallback is the old viewer clock.
  const _plantClock = () => NIMBUS.Util?.plantClock?.(Store.selectedPlant) ?? new Date();
  const _plantToday = () => NIMBUS.Util?.plantToday?.(Store.selectedPlant) ?? Util.startOfDay(new Date());

  // Confidence horizon: the selected plant's own conf_score_horizon (what the Plant
  // settings tab edits and shows), then the per-user setting, then 14 days. Reading only
  // the user setting made the score ignore the plant's configured horizon.
  function _confHorizonMinutes() {
    return Store.masterPlant(Store.selectedPlant)?.conf_score_horizon ?? Store.userSettings?.confidenceHorizonMinutes ?? 20160;
  }

  // H3f: command-palette actions used to push an empty undo, so Ctrl+Z reverted an
  // UNRELATED earlier edit. Snapshot the affected tasks (and which of them were firmed —
  // firmedIds is a separate set that restoreTasks does not rebuild) before mutating.
  // `firmOnly`: a pure Firm/Unfirm change restores only the firm membership. Restoring whole task
  // snapshots would emit an 'undo' bulk update, which is an atomic-optimizer marker for Save.
  function _pushTaskUndo(label, ids, firmOnly = false) {
    const snap = firmOnly ? null : UndoStack.snapshotTasks(ids);
    const wasFirmed = new Set(ids.filter(id => Store.isFirmed(id)).map(String));
    UndoStack.push(label, () => {
      if (snap) UndoStack.restoreTasks(snap);
      const live = ids.filter(id => Store.tasks[id]);
      const on  = live.filter(id => wasFirmed.has(String(id)));
      const off = live.filter(id => !wasFirmed.has(String(id)));
      if (on.length)  Store.setFirmed(on, true, 'undo');
      if (off.length) Store.setFirmed(off, false, 'undo');
      Alerts.scheduleRecompute();
    }, ids);   // ids let distribution writes drop stale undo entries
  }

  // The palette's one "jump to the first conflict" path (the Right Now card, the intent and the action row used to
  // carry three copies, one of which only worked for alerts that name an order). Routed through the alert focus
  // (not the Gantt focus directly) so it also works for the order-less alerts (every overload / closed / calendar
  // alert); the focus itself brings the Timeline forward. `emptyKey` is the toast shown when nothing is in conflict.
  function _jumpToFirstConflict(emptyKey) {
    const err = (Store.alerts || []).filter(a => a.sev === 'err').sort((a, b) => a.time - b.time)[0];
    if (!err) { Toast.show(t(emptyKey), 'info', 1800); return; }
    NIMBUS.AlertsUIAdapter.focus(err.id);
  }

  // Go to a machine's row on the Gantt: the shared line + day navigation (the same call an alert's Go To makes),
  // on `dayKey` when the caller knows the day that matters (an overloaded day), else on today. Falls back to
  // focusing any order on the line when the navigation is not available.
  function _gotoLine(line, dayKey) {
    NIMBUS.App.gotoGanttTimeline();
    const day = dayKey || NIMBUS.Util?.dayKey?.(_plantToday());
    const goto = NIMBUS.Timeline?.gotoLineDay;   // late-bound (the idiom above) so the legacy-surface ratchet does not grow
    if (day && goto) { goto.call(NIMBUS.Timeline, line, day); return; }
    const sample = Store.tasksForSelectedPlant().find(x => x.MACHINE === line);
    if (sample) setTimeout(() => NIMBUS.Timeline.focus(String(sample.id)), 100);
  }

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
  width:520px; max-width:calc(100vw - 48px); max-height:calc(100vh - 104px);
  background:linear-gradient(160deg,var(--bg-elev) 0%,var(--bg-subtle) 100%);
  border:1.5px solid rgba(199,198,189,0.7);
  border-radius:20px;
  box-shadow:0 24px 64px rgba(26,27,31,0.18),0 8px 24px rgba(26,27,31,0.1),0 1px 4px rgba(26,27,31,0.06);
  overflow:hidden; display:flex; flex-direction:column;
  opacity:0; visibility:hidden; transform:translateY(20px) scale(0.96); pointer-events:none;
  transition:opacity 220ms ease,transform 260ms cubic-bezier(0.34,1.56,0.64,1);
}
#ni-cmd-panel.ni-cp-open { opacity:1; visibility:visible; transform:translateY(0) scale(1); pointer-events:auto; }

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
  border-top:1px solid var(--line); display:flex; flex-wrap:wrap; gap:8px 12px; align-items:center;
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
#ni-lang-pill{width:100px;min-width:70px;height:28px;padding:3px 6px;border-radius:var(--r-sm);background:var(--bg-elev);border:1px solid var(--line-strong);cursor:pointer;font-size:11px;font-weight:600;color:var(--fg);}
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
.ni-tm-panel { position:fixed; top:calc(var(--chrome-h) + 8px); right:16px; width:340px; max-width:calc(100vw - 32px); max-height:min(480px, calc(100vh - var(--chrome-h) - 24px));
  background:var(--bg-elev); border:1.5px solid var(--line-strong); border-radius:var(--r-xl);
  box-shadow:var(--shadow-lg); z-index:500; display:flex; flex-direction:column; overflow:hidden; }
.ni-tm-panel[hidden] { display:none !important; }
.ni-tm-head { display:flex; align-items:center; justify-content:space-between; padding:12px 14px;
  border-bottom:1px solid var(--line); font-size:13px; }
.ni-tm-close { background:none; border:none; cursor:pointer; font-size:16px; color:var(--fg-mute); padding:2px 6px; }
.ni-tm-list { overflow-y:auto; flex:1; min-height:0; }
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
  border-radius:50%; flex-shrink:0;
  -webkit-mask-image: radial-gradient(circle, transparent 5px, #000 5px);
  mask-image: radial-gradient(circle, transparent 5px, #000 5px); }
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
.ni-diff-dlg { border:none; padding:0; border-radius:var(--r-xl); box-shadow:var(--shadow-lg); width:720px; max-width:96vw; max-height:calc(100vh - 32px); overflow:auto; color:var(--fg); background:var(--bg-elev); }
.ni-diff-dlg::backdrop { background:rgba(26,27,31,0.45); }
.ni-diff-dlg > div { background:var(--bg-elev); border-radius:var(--r-xl); }
/* snap picker list */
.ni-diff-snaplist { max-height:200px; overflow-y:auto; border:1.5px solid var(--line);
  border-radius:var(--r-md); background:var(--bg); scrollbar-width:thin; scrollbar-color:var(--line) transparent; }
.ni-diff-snaplist::-webkit-scrollbar { width:5px; }
.ni-diff-snaplist::-webkit-scrollbar-thumb { background:var(--line); border-radius:3px; }
.ni-diff-snap-row { display:grid; grid-template-columns:88px 1fr auto; align-items:center; gap:8px;
  width:100%; text-align:left; font:inherit; color:var(--fg); background:var(--bg-elev); border:0;
  padding:8px 12px; cursor:pointer; border-bottom:1px solid var(--line); border-left:2px solid transparent; transition:background 0.1s,border-color 0.1s; }
.ni-diff-snap-row:focus-visible { outline:2px solid var(--accent); outline-offset:-2px; }
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
.ni-diff-kind { font-size:9.5px; font-weight:700; text-transform:uppercase; letter-spacing:0.06em;
  padding:1px 5px; border-radius:3px; background:var(--bg-subtle); color:var(--fg-mute); margin-right:4px; }
.ni-diff-kind.finish, .ni-diff-kind.split { background:color-mix(in srgb,var(--warn,#b57a0a) 16%,transparent); color:var(--warn,#b57a0a); }
.ni-diff-finish { font-size:11px; color:var(--fg-mute); margin-left:6px; }
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

    // Resolves with the stored record's KEY (the autoIncrement id for snapshots). It used to
    // resolve with the transaction's complete event, so `snap.id = id` stored an Event.
    put(store, value) {
      if (!IntelDB._db) return Promise.resolve();
      return new Promise((res, rej) => {
        const tx = IntelDB._db.transaction(store, 'readwrite');
        const req = tx.objectStore(store).put(value);
        tx.oncomplete = () => res(req.result);
        tx.onerror    = e => rej(e.target.error);
        // A quota or constraint abort fires onabort without a prior onerror on the transaction: without this the
        // promise never settled and the snapshot's caller waited forever.
        tx.onabort    = () => rej(tx.error || new Error('IndexedDB transaction aborted'));
      });
    },

    // Newest `n` records of a store via a reverse cursor on an index (no getAll of the whole
    // store), returned oldest-first.
    getNewest(store, indexName, n) {
      if (!IntelDB._db) return Promise.resolve([]);
      return new Promise((res, rej) => {
        const out = [];
        const tx  = IntelDB._db.transaction(store, 'readonly');
        const req = tx.objectStore(store).index(indexName).openCursor(null, 'prev');
        req.onsuccess = e => {
          const cursor = e.target.result;
          if (cursor && out.length < n) { out.push(cursor.value); cursor.continue(); }
          else res(out.reverse());
        };
        req.onerror = e => rej(e.target.error);
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
      // Count, then walk the ts index with a KEY cursor (keys only: no snapshot payloads are
      // loaded) deleting the oldest by primary key until keepN remain.
      const fn = () => {
        // Runs from an idle callback: a closed database (transaction() throws) must not surface as an uncaught error.
        try {
          const tx = IntelDB._db.transaction('snapshots', 'readwrite');
          const os = tx.objectStore('snapshots');
          const countReq = os.count();
          countReq.onsuccess = () => {
            let excess = countReq.result - keepN;
            if (excess <= 0) return;
            const curReq = os.index('ts').openKeyCursor();
            curReq.onsuccess = e => {
              const cursor = e.target.result;
              if (!cursor || excess <= 0) return;
              os.delete(cursor.primaryKey);
              excess -= 1;
              cursor.continue();
            };
          };
        } catch (e) {
          (window.NIMBUS && window.NIMBUS.ErrorLog
            ? window.NIMBUS.ErrorLog.warn('intel', 'IntelDB snapshot prune failed', { err: String(e), errorCode: 'internal' })
            : console.warn('[IntelDB] snapshot prune failed', e));
        }
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
      // Every order is finish-anchored: a row with a finish and no stored start is placed (its start is derived), so
      // only a row with neither date still needs scheduling.
      const unscheduled = tasks.filter(t => !t.start_date && !t.end_date);

      // Peak utilization — use sync compute, but trigger worker refresh for next call. Only days that count as
      // overloaded under the shared rule (the alert's 0.05 h tolerance) are tracked, so a full day never reads as
      // overloaded here while the alert says it is fine; maxUtil stays 0 when there is none.
      let maxUtil = 0, overloadedLine = null, overloadedDay = null;
      try {
        // One clock (OQ52 / I13): the plant's today, the same start the Dashboard matrix and the prewarm use.
        const now = _plantToday();
        // computeMatrix serves the shared cache (the async prewarm fills it) and fills it itself on a miss;
        // the old extra worker post here only repeated that work and wrote an unresolved matrix.
        const matrix = Utilization.computeMatrix(now, 7);

        for (const [line, lineData] of Object.entries(matrix)) {
          for (const [day, row] of Object.entries(lineData)) {
            if (row.effectiveCapacity > 0 && NimbusComputeCore.isOverloaded(row.scheduled, row.effectiveCapacity)) {
              const ratio = row.scheduled / row.effectiveCapacity;
              if (ratio > maxUtil) { maxUtil = ratio; overloadedLine = line; overloadedDay = day; }
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

      // Blackout risk (orders that touch a blackout starting or running within the next 48 h). The window is the
      // plant's clock; a blackout already in progress counts (it has not ended yet); and a blackout only puts an
      // order at risk when it covers that order's own line (a line blackout) or plant (a plant blackout).
      let blackoutRisk = 0;
      try {
        const now2    = _plantClock().getTime();
        const horizon = now2 + 48 * 3600000;
        const win = b => { const s = +new Date(b.start), e = +new Date(b.end); return { b, s, e }; };
        const bkts = Store.blocks.concat(Store.plantBlocks).map(win)
          .filter(w => Number.isFinite(w.s) && Number.isFinite(w.e) && w.e > now2 && w.s < horizon);
        if (bkts.length) {
          blackoutRisk = tasks.filter(t => {
            const taskPlant = t.PLANT || Store.selectedPlant;
            const hits = bkts.filter(({ b }) => (!b.plant || b.plant === taskPlant) && (!b.line || b.line === t.MACHINE));
            return hits.length && Util.scheduleIntervals(t).some(interval =>
              hits.some(h => interval.end.getTime() > h.s && interval.start.getTime() < h.e));
          }).length;
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
        overloadedDay,
        minsSinceSnap,
        confScore:     Confidence._score,
        confDelta,
        selSize,
        selIds,
        selStats,
        sandboxActive:  !!NIMBUS.Sandbox?.active,
        anyFilterActive: !!(
          // isActive() covers colour, form, pasted-id and text filters (activeFilter() only holds the text box).
          NIMBUS.GanttFilter?.isActive?.() ||
          (NIMBUS.GanttFilter?.selectedLines()?.size > 0)
        ),
        undoDepth:     NIMBUS.UndoStack?._entries?.length || 0,
        blackoutRisk,
        snapshotCount: plantSnaps.length,
        hasPlant:      !!Store.selectedPlant,
        distributionReviewCount: Store.distributionSummary?.needs_review ?? 0,
      };
    },

    _bank: null,

    _buildBank() {
      return [
        {
          id: 'conflict-jump',
          label: s => t('cmdp.need_conflict_jump', { count: s.errCount, plural: s.errCount !== 1 ? 's' : '' }),
          sub:   () => t('cmdp.sub_scroll_to_overlap'),
          icon:  '🚨',
          score: s => s.errCount > 0 ? 90 + Math.min(s.errCount * 2, 9) : 0,
          when:  s => s.errCount > 0 && s.hasPlant,
          run()  {
            CommandPalette.close();
            _jumpToFirstConflict('toast.no_active_conflicts');
          }
        },
        {
          id: 'overload-inspect',
          label: s => t('cmdp.need_overload_inspect', { line: s.overloadedLine, pct: Math.round(s.maxUtil * 100) }),
          sub:   () => t('cmdp.sub_scroll_to_overloaded_line'),
          icon:  '⚠️',
          score: s => s.maxUtil >= 1.0 ? 70 + Math.min(Math.round((s.maxUtil - 1) * 50), 20) : 0,
          when:  s => s.maxUtil >= 1.0 && s.hasPlant,
          run(s) {
            CommandPalette.close();
            _gotoLine(s.overloadedLine, s.overloadedDay);   // the overloaded day, not just any order on the line
          }
        },
        {
          id: 'unscheduled-review',
          label: s => t('cmdp.need_unscheduled_review', { count: s.unscheduledCount, plural: s.unscheduledCount !== 1 ? 's' : '' }),
          sub:   () => t('cmdp.sub_switch_to_orders_table'),
          icon:  '📋',
          score: s => s.unscheduledCount > 0 ? 60 + Math.min(s.unscheduledCount, 15) : 0,
          when:  s => s.unscheduledCount > 0 && s.hasPlant,
          run()  { CommandPalette.close(); NIMBUS.App.goto('table'); }
        },
        {
          id: 'snapshot-due',
          label: s => t('cmdp.need_snapshot_due', { mins: s.minsSinceSnap }),
          sub:   () => t('cmdp.sub_take_checkpoint'),
          icon:  '📸',
          score: s => (s.minsSinceSnap !== null && s.minsSinceSnap >= 20)
            ? 40 + Math.min(Math.floor(s.minsSinceSnap / 5), 25) : 0,
          when:  s => s.minsSinceSnap !== null && s.minsSinceSnap >= 20 && s.hasPlant,
          run()  {
            CommandPalette.close();
            const label = `Manual · ${Util._fmtTimePref(new Date())}`;
            TimeMachine.snapshot(label);
            Toast.show(t('toast.snapshot_saved'), 'success', 1400);
          }
        },
        {
          id: 'first-snapshot',
          label: () => t('cmdp.need_first_snapshot'),
          sub:   () => t('cmdp.sub_save_first_entry'),
          icon:  '📸',
          score: s => s.snapshotCount === 0 && s.hasPlant ? 55 : 0,
          when:  s => s.snapshotCount === 0 && s.hasPlant,
          run()  {
            CommandPalette.close();
            const label = `First snapshot · ${Util._fmtTimePref(new Date())}`;
            TimeMachine.snapshot(label);
            Toast.show(t('toast.snapshot_saved'), 'success', 1400);
          }
        },
        {
          id: 'blackout-risk',
          label: s => t('cmdp.need_blackout_risk', { count: s.blackoutRisk, plural: s.blackoutRisk !== 1 ? 's' : '' }),
          sub:   () => t('cmdp.sub_review_blackout_overlap'),
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
          id: 'distribution-review',
          label: s => t('cmdp.need_distribution_review', { count: s.distributionReviewCount }),
          sub:   () => t('cmdp.sub_view_distribution'),
          icon:  '📦',
          score: s => s.distributionReviewCount > 0 ? 50 + Math.min(s.distributionReviewCount, 15) : 0,
          when:  s => s.distributionReviewCount > 0 && s.hasPlant,
          run()  {
            CommandPalette.close();
            NIMBUS.App.goto('gantt');
            NIMBUS.App.gotoGanttSub('distribution');
          }
        },
        {
          id: 'sandbox-active',
          label: () => t('cmdp.need_sandbox_active'),
          sub:   () => t('cmdp.sub_whatif_mode'),
          icon:  '🔮',
          score: s => s.sandboxActive ? 85 : 0,
          when:  s => s.sandboxActive,
          run()  { CommandPalette.close(); NIMBUS.Sandbox?.showPanel?.(); }
        },
        {
          id: 'diff-available',
          label: () => t('cmdp.label_compare_snapshot'),
          sub:   () => t('cmdp.sub_open_diff_viewer'),
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
          keywords: ['freeze', 'lock', 'firm all', 'pin'],
          label: t('cmdp.intent_freeze_label'),
          sub:   t('cmdp.intent_freeze_sub'),
          icon:  '🔒',
          run() {
            CommandPalette.close();
            // Scoped to the SELECTED plant, and to orders that can still take a firm: frozen and running
            // orders are already locked (firmPlan), so they are neither counted nor written.
            const plantIds = Store.tasksForSelectedPlant().map(t => t.id);
            const freezePlan = NIMBUS.Engine?.firmPlan?.(plantIds);
            const unfirmedIds = freezePlan?.firm ?? [];
            const lockedCount = freezePlan?.locked?.length ?? 0;
            if (unfirmedIds.length) {
              // A firm is shared with every planner once saved, so a bulk Firm All asks first.
              // Native confirm on purpose: Modal.confirm would add a NIMBUS.Modal consumer to this
              // classic script, and the legacy-surface ratchet only allows that surface to shrink.
              if (!window.confirm(t('confirm.firm_all', { count: unfirmedIds.length }))) return;
              _pushTaskUndo('Firm All (freeze)', unfirmedIds, true);
              NIMBUS.Engine?.applyFirm?.(unfirmedIds, true, 'cmd-palette');
            }
            Alerts.scheduleRecompute();
            const label = `Frozen · ${Util._fmtTimePref(new Date())}`;
            TimeMachine.snapshot(label);
            Toast.show(t('toast.freeze_saved'), 'success', 3000);
            if (lockedCount) Toast.show(t('toast.firm_skipped_locked', { n: lockedCount }), 'info');
          }
        },
        {
          keywords: ['compare', 'diff', 'what changed', 'changed', 'delta'],
          label: t('cmdp.label_compare_snapshot'),
          sub:   t('cmdp.sub_open_diff_viewer'),
          icon:  '⇄',
          run()  { CommandPalette.close(); Diff.showUI(); }
        },
        {
          keywords: ['rush', 'urgent', 'emergency', 'priority', 'hot'],
          label: t('cmdp.intent_rush_label'),
          sub:   t('cmdp.intent_rush_sub'),
          icon:  '🔮',
          run()  { CommandPalette.close(); NIMBUS.SandboxAdapter?.enter?.(); }
        },
        {
          keywords: ['optimize', 'run optim', 'scheduler', 'reorder'],
          label: t('cmdp.label_optimize_schedule'),
          sub:   t('cmdp.sub_run_optimizer'),
          icon:  '⚙',
          run()  { CommandPalette.close(); NIMBUS.OptimizeDialog?.open?.(); }
        },
        {
          keywords: ['export', 'print', 'pdf', 'download', 'report'],
          label: t('cmdp.label_print_export_schedule'),
          sub:   t('cmdp.sub_open_export_dialog'),
          icon:  '🖨️',
          run()  { CommandPalette.close(); NIMBUS.Printer?.open?.(); }
        },
        {
          keywords: ['snapshot', 'save', 'checkpoint', 'backup', 'history'],
          label: t('cmdp.label_take_snapshot_now'),
          sub:   t('cmdp.sub_take_checkpoint'),
          icon:  '📸',
          run()  {
            CommandPalette.close();
            const label = `Intent · ${Util._fmtTimePref(new Date())}`;
            TimeMachine.snapshot(label);
            Toast.show(t('toast.snapshot_saved'), 'success', 1400);
          }
        },
        {
          keywords: ['conflict', 'error', 'overlap', 'alert', 'problem'],
          label: t('cmdp.label_jump_first_conflict'),
          sub:   t('cmdp.sub_scroll_to_error_alert'),
          icon:  '🚨',
          run()  {
            CommandPalette.close();
            _jumpToFirstConflict('toast.no_conflicts_clean');
          }
        },
      ];

      // A keyword must start a word: plain substring matching offered Freeze for "!shipping" (pin) and Rush for
      // "!photo" (hot). Inflections still match ("locked", "exporting"), only a match from the middle of a word does not.
      const startsWord = kw => new RegExp(`(?:^|[^a-z0-9])${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(q);
      const results = bank.filter(intent => intent.keywords.some(startsWord));
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
  let commandPaletteOpener = null;
  const CommandPalette = {
    _panel:     null,
    _index:     null,
    _results:   [],
    _cursor:    0,
    _lastQuery: '',

    init() {
      CommandPalette._buildPanel();
      document.addEventListener('keydown', e => {
        // Lower-cased: with Caps Lock on, the key arrives as 'K'.
        if ((e.metaKey || e.ctrlKey) && String(e.key || '').toLowerCase() === 'k') {
          e.preventDefault();
          if (!Store.selectedPlant) return;
          CommandPalette.open();
        }
      });
      Store.subscribe(evt => {
        // The index holds each order's label (name, machine, colour) and the firm-dependent selection commands, so a
        // single edit, a removal and a firm change must drop it too, not only the bulk events.
        if (!evt?.type || evt.type === 'tasks:bulk' || evt.type === 'tasks:bulkUpdate' || evt.type === 'plant:selected'
            || evt.type === 'task:update' || evt.type === 'task:remove' || evt.type === 'firmed:change')
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
          <input class="ni-cp-input" id="ni-cp-input" placeholder="${t('cmdp.search_placeholder')}" autocomplete="off" spellcheck="false">
          <button class="ni-cp-close-btn" id="ni-cp-close-btn" title="${t('cmdp.close_button_title')}">✕</button>
        </div>
        <div class="ni-cp-results" id="ni-cp-results"></div>
        <div class="ni-cp-footer">
          <span class="ni-cp-hint"><kbd>↑↓</kbd> ${t('ui.hint_navigate')}</span>
          <span class="ni-cp-hint"><kbd>↵</kbd> ${t('ui.hint_select')}</span>
          <span class="ni-cp-hint"><kbd>esc</kbd> ${t('ui.hint_close')}</span>
          <span class="ni-cp-index-count" id="ni-cp-index-count"></span>
          <select id="ni-lang-pill" title="${t('tip.lang_switcher')}" aria-label="${t('tip.lang_switcher')}">
            ${LangSwitcher._langs.map(l => `<option value="${l.code}"${l.code === LangSwitcher.current() ? ' selected' : ''}>${l.label} — ${l.name}</option>`).join('')}
          </select>
          <button type="button" id="ni-dm-pill" title="${t('tip.toggle_light_dark')}" aria-label="${t('tip.toggle_light_dark')}" aria-pressed="${DarkMode.isDark()}">
            <span class="ni-dm-icon" aria-hidden="true">☀️</span><span class="ni-dm-thumb"></span><span class="ni-dm-icon" aria-hidden="true">🌙</span>
          </button>
        </div>`;
      document.body.appendChild(panel);
      CommandPalette._panel = panel;

      panel.querySelector('#ni-cp-close-btn').addEventListener('click', () => CommandPalette.close());
      const pill = panel.querySelector('#ni-dm-pill');
      if (DarkMode.isDark()) pill.classList.add('ni-dm-dark');
      pill.addEventListener('click', () => DarkMode.toggle());

      const langPill = panel.querySelector('#ni-lang-pill');
      langPill.addEventListener('change', () => {
        // A failed save keeps the current language (no reload): put the select back.
        Promise.resolve(LangSwitcher.set(langPill.value)).then(ok => { if (ok === false) langPill.value = LangSwitcher.current(); });
      });
      panel.addEventListener('keydown', e => {
        if (e.key === 'Escape' && e.target !== langPill) {
          e.preventDefault(); e.stopPropagation(); CommandPalette.close();
        }
      });

      const input = panel.querySelector('#ni-cp-input');
      input.addEventListener('focus',  () => panel.classList.add('ni-cp-focused'));
      input.addEventListener('blur',   () => panel.classList.remove('ni-cp-focused'));
      input.addEventListener('input',  Util.debounce(() => CommandPalette._search(input.value), 60));
      input.addEventListener('keydown', e => {
        if (e.key === 'ArrowDown') { e.preventDefault(); CommandPalette._move(1); }
        if (e.key === 'ArrowUp')   { e.preventDefault(); CommandPalette._move(-1); }
        if (e.key === 'Enter') {
          e.preventDefault();
          // Enter inside the 60 ms input debounce would run the PREVIOUS query's top result: search what is typed first.
          if (input.value.trim() !== CommandPalette._lastQuery) CommandPalette._search(input.value);
          CommandPalette._activate();
        }
        if (e.key === 'Escape')    { CommandPalette.close(); }
      });
      document.addEventListener('mousedown', e => {
        if (CommandPalette.isOpen() && !panel.contains(e.target) && e.target !== fab)
          CommandPalette.close();
      });
    },

    _buildIndex() {
      const idx = [...CommandPalette._buildSelectionCommands()];
      const tasks = Store.tasksForSelectedPlant();
      for (const t of tasks) {
        const order = t.ORDER || t.PRODUCTION_ORDER;
        const label = [t.text, order, t.MATERIAL_NUMBER].filter(Boolean).join(' · ');
        const sub   = `${t.MACHINE || '?'} · ${t.COLOR || ''}`.trim().replace(/·\s*$/, '');
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
      const lines = [...new Set(tasks.map(t => t.MACHINE).filter(Boolean))];
      for (const line of lines) {
        idx.push({
          type: 'line', label: t('cmdp.label_go_to_line', { line }), sub: t('cmdp.sub_scroll_to_this_line'), icon: '🏭',
          run() {
            CommandPalette.close();
            _gotoLine(line);
          }
        });
        idx.push({
          type: 'line', label: t('cmdp.label_isolate_line', { line }), sub: t('cmdp.sub_show_only_this_line'), icon: '⊕',
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
        { type:'action', label:t('cmdp.label_jump_first_conflict_title'), sub:t('cmdp.sub_scroll_to_error_alert'), icon:'🚨',
          run(){
            CommandPalette.close();
            _jumpToFirstConflict('toast.no_conflicts_clean');
          } },
        { type:'action', label:t('cmdp.label_take_snapshot_title'), sub:t('cmdp.sub_save_manual_checkpoint'), icon:'📷',
          run(){
            CommandPalette.close();
            const label = `Manual · ${Util._fmtTimePref(new Date())}`;
            TimeMachine.snapshot(label);
            Toast.show(t('toast.snapshot_saved'), 'success', 1400);
          } },
        { type:'action', label:t('cmdp.label_print_export_title'), sub:t('cmdp.sub_open_print_export_dialog'), icon:'🖨️',
          run(){ CommandPalette.close(); NIMBUS.Printer?.open?.(); } },
        { type:'action', label:t('cmdp.label_go_to_now'), sub:t('cmdp.sub_center_gantt_on_now'), icon:'⊙',  run(){ CommandPalette.close(); NIMBUS.App.gotoGanttTimeline(); NIMBUS.Timeline.gotoNow?.(); } },
        { type:'action', label:t('cmdp.label_time_machine'), sub:t('cmdp.sub_browse_schedule_history'), icon:'⏱', run(){ CommandPalette.close(); TimeMachine.openUI(); } },
        { type:'action', label:t('cmdp.label_compare_schedules'), sub:t('cmdp.sub_diff_current_vs_snapshot'), icon:'⇄',  run(){ CommandPalette.close(); Diff.showUI(); } },
        { type:'action', label:t('cmdp.label_ripple_preview'), sub:t('cmdp.sub_ripple_preview'), icon:'≋',
          run(){ CommandPalette.close(); NIMBUS.App.gotoGanttTimeline(); Toast.show(t('toast.ripple_howto'), 'info', 4000); } },
        { type:'action', label:t('cmdp.label_reload_data'), sub:t('cmdp.sub_reread_excel'), icon:'↺', run(){ CommandPalette.close(); NIMBUS.Persistence?.reload?.(); } }
      );
      CommandPalette._index = idx;
      const actionCt = idx.filter(i => i.type === 'action').length;
      const lineCt   = idx.filter(i => i.type === 'line'  ).length / 2;
      const orderCt  = idx.filter(i => i.type === 'order' ).length;
      const selCt    = idx.filter(i => i.type === 'selection').length;
      const countEl  = document.getElementById('ni-cp-index-count');
      if (countEl) {
        const selPart = selCt ? ` · ${t('cmdp.index_selection_count', { count: selCt })}` : '';
        countEl.textContent = `${t('cmdp.index_actions_count', { count: actionCt })} · `
          + `${t('cmdp.index_lines_count', { count: Math.round(lineCt) })} · `
          + `${t('cmdp.index_orders_count', { count: orderCt })}${selPart}`;
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

      // Intent mode: "need: ..." or "! ..." (the prefix in any case: "Need:" typed after a capital or Caps Lock)
      if (/^(need:|!)/i.test(q)) {
        const intentText = q.replace(/^(need:|!)/i, '').trim();
        if (intentText) {
          CommandPalette._results = NeedsEngine.resolveIntent(intentText);
          if (!CommandPalette._results.length) {
            CommandPalette._results = [{
              type: 'intent', icon: '💡',
              label: t('cmdp.no_match_hint'),
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

    // Match on the RAW text and escape each piece afterwards: matching inside the already-escaped string let "a"
    // light up the "a" of "&amp;" (a broken entity) and shifted every index after an escaped character.
    _highlight(text, q) {
      const raw = String(text);
      const esc = CommandPalette._esc;
      if (!q) return esc(raw);
      const lo = raw.toLowerCase(), qLo = q.toLowerCase();
      if (lo.length !== raw.length) return esc(raw);   // a character whose lower case changes length: no safe indexes
      const idx = lo.indexOf(qLo);
      if (idx !== -1)
        return esc(raw.slice(0, idx)) + '<mark>' + esc(raw.slice(idx, idx + q.length)) + '</mark>' + esc(raw.slice(idx + q.length));
      let out = '', qi = 0;
      for (let i = 0; i < raw.length; i++) {
        if (qi < qLo.length && lo[i] === qLo[qi]) { out += `<mark>${esc(raw[i])}</mark>`; qi++; }
        else out += esc(raw[i]);
      }
      return out;
    },

    _buildSelectionCommands() {
      const ids   = NIMBUS.Selection?.ids?.() || [];
      const n     = ids.length;
      if (!n) return [];

      // Lock-aware (D4/C10): a mixed selection offers Firm (n) when anything can be firmed, else Unfirm (n)
      // when anything is planner-only firmed, else no command (frozen / running orders take neither).
      const plan  = NIMBUS.Engine?.firmPlan?.(ids) || { firm: [], unfirm: [], locked: [] };
      const cmds  = [];
      const newFirmed = plan.firm.length > 0;
      const firmIds = newFirmed ? plan.firm : plan.unfirm;

      // Firm / Unfirm
      if (firmIds.length) cmds.push({
        type: 'selection',
        icon:  newFirmed ? '🔒' : '🔓',
        label: newFirmed ? t('cmdp.label_firm_selected', { count: firmIds.length }) : t('cmdp.label_unfirm_selected', { count: firmIds.length }),
        sub:   newFirmed ? t('cmdp.sub_pin_orders_in_place') : t('cmdp.sub_make_orders_moveable'),
        run() {
          CommandPalette.close();
          // Undo covers only the ids that actually change.
          _pushTaskUndo(`${newFirmed ? 'Firm' : 'Unfirm'} ${firmIds.length} orders`, firmIds, true);
          const res = NIMBUS.Engine?.applyFirm?.(firmIds, newFirmed, 'cmd-palette') || { changed: [], skipped: [] };
          Alerts.scheduleRecompute();
          const count = res.changed.length;
          Toast.show(newFirmed ? t('toast.firmed_orders', { count }) : t('toast.unfirmed_orders', { count }), 'success', 1400);
          if (res.skipped.length) Toast.show(t('toast.firm_skipped_locked', { n: res.skipped.length }), 'info', 2200);
        }
      });

      // Push +1 hour
      cmds.push({
        type: 'selection',
        icon:  '⏩',
        label: t('cmdp.label_push_selected', { count: n }),
        sub:   t('cmdp.sub_shift_orders_1h'),
        run() {
          CommandPalette.close();
          // Push moves the FINISH one hour later and the start follows (backward scheduling OQ8). Firmed,
          // frozen and running orders stay where they are; an order whose new finish cannot be held on the
          // machine's working hours is skipped too (quiet: the one summary toast below counts what moved).
          const patches = NIMBUS.Engine?.pushFinishPatches?.(ids.map(id => Store.tasks[id]).filter(Boolean), 3600000) || [];
          const moved = patches.length;
          const skipped = Math.max(0, ids.filter(id => Store.tasks[id]).length - moved);   // U34: say why fewer moved than selected
          if (moved) {
            _pushTaskUndo(t('undo.push_orders_1h', { count: moved }), patches.map(p => p.id));
            Store.updateMany(patches, 'cmd-palette');
          }
          Alerts.scheduleRecompute();
          Toast.show(
            moved ? t(skipped ? 'toast.pushed_orders_skipped' : 'toast.pushed_orders', { count: moved, skipped }) :
              t('cmdp.toast_no_orders_moveable'),
            patches.length ? 'success' : 'warn', patches.length ? 1400 : 3000);
        }
      });

      // Move by...
      cmds.push({
        type: 'selection',
        icon:  '📐',
        label: t('cmdp.label_move_by', { count: n }),
        sub:   t('cmdp.sub_move_by'),
        run() {
          CommandPalette.close();
          void NIMBUS.Interaction?.promptMoveBy?.(ids);
        }
      });

      // Unschedule
      cmds.push({
        type: 'selection',
        icon:  '🗑️',
        label: t('cmdp.label_unschedule_selected', { count: n }),
        sub:   t('cmdp.sub_remove_start_end_times'),
        run() {
          CommandPalette.close();
          // One implementation: the Gantt Delete key. It owns the guard (manual,
          // frozen, running, split), the Needs Planning patch, undo and alerts.
          NIMBUS.Interaction.unscheduleIds(ids);
        }
      });

      // Snapshot before acting
      cmds.push({
        type: 'selection',
        icon:  '📸',
        label: t('cmdp.label_snapshot_before_acting', { count: n }),
        sub:   t('cmdp.sub_save_checkpoint_now'),
        run() {
          CommandPalette.close();
          const label = `Pre-selection · ${n} orders · ${Util._fmtTimePref(new Date())}`;
          TimeMachine.snapshot(label);
          Toast.show(t('toast.snapshot_saved'), 'success', 1400);
        }
      });

      return cmds;
    },

    isOpen() { return CommandPalette._panel?.classList.contains('ni-cp-open'); },

    open() {
      if (!CommandPalette._panel) return;
      if (!CommandPalette.isOpen()) commandPaletteOpener = document.activeElement;
      if (!CommandPalette._index) CommandPalette._buildIndex();
      CommandPalette._search('');
      CommandPalette._panel.classList.add('ni-cp-open');
      document.getElementById('ni-cmd-fab')?.classList.add('ni-fab-active');
      setTimeout(() => { if (CommandPalette.isOpen()) document.getElementById('ni-cp-input')?.focus(); }, 30);
    },

    close() {
      const returnFocus = CommandPalette._panel?.contains(document.activeElement);
      CommandPalette._panel?.classList.remove('ni-cp-open');
      document.getElementById('ni-cmd-fab')?.classList.remove('ni-fab-active');
      const inp = document.getElementById('ni-cp-input');
      if (inp) inp.value = '';
      CommandPalette._lastQuery = '';
      if (returnFocus) commandPaletteOpener?.focus?.();
    }
  };

  // Snapshot/diff encoding of a split order: sorted [startMs, endMs] pairs, or
  // null for a continuous (unsplit) order. Snapshots written before this field
  // existed have no key at all; Diff.compute treats "absent" as unknown.
  function snapshotSegments(t) {
    const segs = Array.isArray(t.scheduleSegments) ? t.scheduleSegments : [];
    if (segs.length < 2) return null;
    const ms = v => (v instanceof Date ? v.getTime() : (v ? new Date(v).getTime() : NaN));
    return segs
      .map(s => [ms(s.startDate ?? s.start_date), ms(s.endDate ?? s.end_date)])
      .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
      .sort((a, b) => a[0] - b[0]);
  }

  // The one encoding of a live order as a snapshot / diff row (snapshot() stores it, Diff compares the live
  // schedule through it), so the two can never disagree on what a row holds. Epoch ms or null for a missing or
  // unreadable date. PRODUCTION_VERSION is kept so a restore on a routing plant can put the pair back (rows from
  // older snapshots have none: unknown).
  function snapshotTask(t) {
    const ms = v => { const n = v instanceof Date ? v.getTime() : (v ? new Date(v).getTime() : NaN); return Number.isFinite(n) ? n : null; };
    return {
      id:               t.id,
      PLANT:            t.PLANT || Store.selectedPlant,
      start_date:       ms(t.start_date),
      end_date:         ms(t.end_date),
      MACHINE:          t.MACHINE  || '',
      PRODUCTION_VERSION: t.PRODUCTION_VERSION || '',
      PRODUCTION_ORDER: t.PRODUCTION_ORDER || '',
      text:             t.text || t.MATERIAL_DESCRIPTION || '',
      COLOR:            t.COLOR     || '',
      FORM_SIZE:        t.FORM_SIZE || '',
      FIRMED:           !!t.firmed,
      scheduleSegments: snapshotSegments(t),
    };
  }

  /* ==========================================================================
     TIME MACHINE — durable IndexedDB snapshot history
     ========================================================================== */
  // In-memory history cap; matches the IndexedDB prune (IntelDB.pruneSnapshots(200)).
  const TM_MAX_SNAPSHOTS = 200;
  let timeMachineOpener = null;

  // Does `line` still exist in `plant`: a master-data machine of the plant, a machine the plant's line settings
  // claim, or one that still carries orders there (the Gantt lists all three).
  function plantHasLine(plant, line) {
    return (Store.masterData?.lines || []).some(r => r.machine === line && (!r.plant || r.plant === plant))
      || Store.lineSettings?.[line]?.plant === plant
      || Store.tasksForSelectedPlant().some(x => x.MACHINE === line);
  }

  // The write that puts one order back as the snapshot row `s` had it: a skip result when it cannot be.
  // The finish comes back and the stored start is a placeholder (the engine re-derives it, see restore()).
  // The MACHINE comes back too when it has moved since the snapshot:
  //  - routing plant: the (production version, machine) pair is the only PV writer there, so the move goes through
  //    the PV-aware pairSchedulePatchFor with the snapshot's version (the order's current one when the snapshot
  //    predates that field); a pair that no longer resolves, or a placement the engine refuses, is a skip;
  //  - other plants: a direct MACHINE write, provided the machine still exists in the plant.
  // A snapshot without a finish (an unplaced order) or without a machine leaves the order's machine alone.
  function restoreRowPatch(task, s, plant, routing) {
    const finish = s.end_date ? new Date(s.end_date) : null;
    const base = {
      start_date: s.start_date ? new Date(s.start_date) : null,
      end_date:   finish,
      // The current split envelope belongs to the current finish. Clear it before Store normalizes dates;
      // reconcile derives fresh pieces.
      scheduleSegments: [],
      runtime_schedule_mismatch: true
    };
    const machine = s.MACHINE || '';
    if (!machine || machine === task.MACHINE || !finish) return { changes: base };
    if (routing) {
      const pv = s.PRODUCTION_VERSION || task.PRODUCTION_VERSION;
      const pair = pv ? NIMBUS.Engine?.pairSchedulePatchFor?.(task, pv, machine, finish, { quiet: true }) : null;
      return pair ? { changes: pair } : { skip: true };
    }
    return plantHasLine(plant, machine) ? { changes: { ...base, MACHINE: machine } } : { skip: true };
  }
  const TimeMachine = {
    _snapshots: [],
    _panel:     null,
    _IntelDB:   IntelDB, // test hook

    init() {
      // Auto-snapshots are debounced (R20): a burst of undoable actions (drag-storm,
      // optimize + auto-reflow) used to deep-copy the ENTIRE task array and write
      // IndexedDB synchronously on EVERY UndoStack.push. Coalescing to one snapshot
      // ~1s after activity settles keeps that work off the hot push path. Manual
      // snapshot() calls (explicit checkpoints) stay immediate.
      // Checked when the timer FIRES, not when it is armed: a What-If session entered inside the debounce window
      // would otherwise snapshot the sandbox's trial schedule as if it were the plan.
      TimeMachine._snapshotAuto = Util.debounce(
        label => { if (!NIMBUS.Sandbox?.active) TimeMachine.snapshot(label, { auto: true }); }, 1000
      );
      Store.subscribe(evt => {
        if (evt.type === 'undo:pushed') TimeMachine._snapshotAuto(evt.label);
      }, 'TimeMachine.autoSnapshot');
      Store.subscribe(evt => {
        if (evt.type === 'plant:selected' && TimeMachine._panel && !TimeMachine._panel.hidden) TimeMachine.closeUI();
      }, 'TimeMachine.panelScope');
      Store.subscribe(evt => {
        if (['tasks:bulk','tasks:bulkUpdate'].includes(evt.type) &&
            evt.source !== 'undo' && evt.source !== 'time-machine') {
          TimeMachine._snapshotAuto(evt.type === 'tasks:bulk' ? 'Data loaded' : 'Bulk update');
        }
      });
      IntelDB.getNewest('snapshots', 'ts', TM_MAX_SNAPSHOTS).then(rows => {
        // Merge, don't replace: a snapshot taken while this read was in flight is already in memory (and in the store).
        const loaded = rows || [];
        const loadedTs = new Set(loaded.map(s => s.ts));
        const early = TimeMachine._snapshots.filter(s => !loadedTs.has(s.ts));
        const merged = (early.length ? loaded.concat(early) : loaded.slice()).sort((a, b) => a.ts - b.ts);
        TimeMachine._snapshots = merged.length > TM_MAX_SNAPSHOTS ? merged.slice(merged.length - TM_MAX_SNAPSHOTS) : merged;
      }).catch(e => {
        (window.NIMBUS && window.NIMBUS.ErrorLog
          ? window.NIMBUS.ErrorLog.warn('intel', 'TimeMachine history load failed', { err: String(e), errorCode: 'internal' })
          : console.warn('[TimeMachine] history load failed', e));
      });
    },

    snapshot(label, opts = {}) {
      const snap = {
        ts:    Date.now(),
        label: (label || 'Snapshot').substring(0, 80),
        auto:  !!opts.auto,
        plant: Store.selectedPlant || null,
        schemaVersion: 2,
        tasks: Store.tasksForSelectedPlant().map(snapshotTask)
      };
      IntelDB.put('snapshots', snap).then(id => {
        snap.id = id || snap.id;
        // The history load may have read this very row back already (it merges by ts): never list it twice.
        if (snap.id == null || !TimeMachine._snapshots.some(s => s.id === snap.id && s.ts === snap.ts)) TimeMachine._snapshots.push(snap);
        if (TimeMachine._snapshots.length > TM_MAX_SNAPSHOTS) {
          TimeMachine._snapshots.splice(0, TimeMachine._snapshots.length - TM_MAX_SNAPSHOTS);
        }
        IntelDB.pruneSnapshots(TM_MAX_SNAPSHOTS);
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
      return Util.fmtDTShortPref(ts);
    },

    openUI() {
      timeMachineOpener = document.activeElement;
      if (!TimeMachine._panel) {
        const p = document.createElement('div');
        p.id = 'ni-tm-panel';
        p.className = 'ni-tm-panel';
        p.setAttribute('role', 'dialog');
        p.setAttribute('aria-label', t('cmdp.label_time_machine'));
        p.addEventListener('keydown', e => {
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); TimeMachine.closeUI(); }
        });
        document.body.appendChild(p);
        TimeMachine._panel = p;
      }
      TimeMachine._panel.hidden = false;
      TimeMachine._renderPanel();
      TimeMachine._panel.querySelector('#ni-tm-close-btn')?.focus();
    },

    closeUI() {
      if (TimeMachine._panel) TimeMachine._panel.hidden = true;
      timeMachineOpener?.focus?.();
    },

    _renderPanel() {
      const p = TimeMachine._panel;
      if (!p) return;
      const snaps = TimeMachine._plantSnaps().slice(-60).reverse();
      p.innerHTML = `
        <div class="ni-tm-head">
          <span>${t('cmdp.label_time_machine')} <span style="font-size:11px;color:var(--fg-mute)">${t('intel.snapshot_entries', { count: snaps.length })}</span></span>
          <button class="ni-tm-close" id="ni-tm-close-btn" aria-label="${t('btn.close')}">✕</button>
        </div>
        <div class="ni-tm-list">
          ${snaps.length ? snaps.map(s => `
            <div class="ni-tm-row">
              <span class="ni-tm-time">${TimeMachine._relTime(s.ts)}</span>
              <span class="ni-tm-label" title="${Util.escapeHtml(s.label)}">${Util.escapeHtml(s.label)}</span>
              <button class="ni-tm-restore-btn" data-ts="${s.ts}">${t('btn.restore')}</button>
            </div>`).join('') : `<div style="padding:16px;font-size:12.5px;color:var(--fg-mute)">${t('ui.no_snapshots_tm')}</div>`}
        </div>`;
      p.querySelector('#ni-tm-close-btn').onclick = () => TimeMachine.closeUI();
      p.querySelectorAll('.ni-tm-restore-btn').forEach(btn => {
        btn.addEventListener('click', () => TimeMachine.restore(+btn.dataset.ts));
      });
    },

    restore(ts) {
      const plant = Store.selectedPlant;
      const snap = plant && TimeMachine._snapshots.find(s => s.ts === ts && s.plant === plant);
      if (!snap) { Toast.show(t('toast.snapshot_not_found'), 'error'); return; }
      const scopedIds = new Set(Store.tasksForSelectedPlant().map(task => String(task.id)));
      const routing = !!Store.masterData?.plants?.some(p => p.plant === plant && p.routing_runtime_enabled);
      let skipped = 0;
      const machineSkipped = [];   // orders whose snapshot machine no longer exists or no longer takes them
      // OQ21 (group 15): a restore brings back the FINISH; the stored start is a placeholder, so each row is flagged
      // stale and the engine re-derives the start from the finish under the current run time. The MACHINE comes
      // back with it (restoreRowPatch): an order moved to another machine since the snapshot returns to the old one.
      const patches = [];
      for (const s of snap.tasks) {
        const task = Store.tasks[s.id];
        if (!task || !scopedIds.has(String(s.id))) continue;
        // Bulk history restore has no explicit protection override or atomic
        // distributed-family workflow. Leave those rows for their own editors.
        if (task.PARENT_ORDER || task.placement_exception || NIMBUS.Engine.firmingStatus(task).firmed) { skipped++; continue; }
        const row = restoreRowPatch(task, s, plant, routing);
        if (row.skip) { machineSkipped.push(task.PRODUCTION_ORDER || task.ORDER || String(s.id)); continue; }
        patches.push({ id: s.id, changes: row.changes });
      }
      if (skipped) Toast.show(t('toast.snapshot_restore_skipped', { count: skipped }), 'warn', 5000);
      if (machineSkipped.length) {
        const shown = machineSkipped.slice(0, 5).join(', ');
        const more = machineSkipped.length > 5 ? ` +${machineSkipped.length - 5}` : '';
        Toast.show(t('toast.snapshot_restore_machine_skipped', { count: machineSkipped.length, orders: shown + more }), 'warn', 7000);
      }
      if (!patches.length) return;
      const affectedIds = patches.map(p => p.id);
      const beforeSnap = UndoStack.snapshotTasks(affectedIds);
      UndoStack.push('Before Time Machine restore', () => UndoStack.restoreTasks(beforeSnap), affectedIds);
      // U31: the rows that already carried unsaved edits BEFORE this restore, read before updateMany dirties them,
      // like the undo path (afterRestore): a never-placed row with a null snapshot start keeps its dirty id.
      const wasDirty = new Set(patches.map(p => String(p.id)).filter(id => NIMBUS.UndoStack?.dirtyProbe?.(id)));
      Store.updateMany(patches, 'time-machine');
      NIMBUS.Engine?.reconcileRestored?.(patches.map(p => p.id), wasDirty);
      Alerts.scheduleRecompute();
      Toast.show(t('toast.restored', { label: snap.label, time: TimeMachine._relTime(ts) }), 'success', 3000);
      TimeMachine.closeUI();
    }
  };

  /* ==========================================================================
     CONFIDENCE — live schedule health score 0-100 + sparkline
     ========================================================================== */
  let breakdownPending = false;   // showBreakdown is fetching its utilization matrix (see the guard there)
  const Confidence = {
    _score:   100,
    _history: [],
    _badge:   null,
    _recomputeDebounced: null,
    _cancelRecomputeDebounced: null,
    _startupTimer: null,
    _startupPending: false,
    _lifecycleGeneration: 0,
    _suppressedAlertRefreshes: 0,

    // Invalidation is deliberately separate from debounce cancellation: a
    // Compute worker request may already be in flight when What-If exits, so
    // clearing its timer alone cannot stop the eventual continuation.
    _invalidatePending(clearSuppressed = false) {
      Confidence._lifecycleGeneration++;
      Confidence._cancelRecomputeDebounced?.();
      if (Confidence._startupTimer) {
        clearTimeout(Confidence._startupTimer);
        Confidence._startupTimer = null;
      }
      if (clearSuppressed) Confidence._suppressedAlertRefreshes = 0;
    },

    _suppressNextAlertRefresh() {
      Confidence._suppressedAlertRefreshes++;
    },

    _scheduleStartupRecompute(delay = 600) {
      if (!Confidence._startupPending || Confidence._startupTimer) return;
      Confidence._startupTimer = setTimeout(() => {
        Confidence._startupTimer = null;
        Confidence._recompute();
      }, delay);
    },

    _canApply(generation, rev) {
      return generation === Confidence._lifecycleGeneration
        && Store.rev() === rev
        && !NIMBUS.OptimizerPreview?.active
        && !NIMBUS.Sandbox?.active;
    },

    init() {
      try { localStorage.removeItem('nimbus.confHistory'); } catch (e) {  // clear any previously persisted history
        (window.NIMBUS && window.NIMBUS.ErrorLog
          ? window.NIMBUS.ErrorLog.warn('intel', 'Confidence history clear failed', { err: String(e), errorCode: 'internal' })
          : console.warn('[Confidence] history clear failed', e));
      }
      // Keep a cancel seam for What-If discard. Store task replacement events
      // fire while Sandbox.active is still true and otherwise leave this timer
      // armed to run against the restored Confidence baseline after exit.
      let confidenceTimer = null;
      Confidence._recomputeDebounced = () => {
        clearTimeout(confidenceTimer);
        confidenceTimer = setTimeout(() => {
          confidenceTimer = null;
          Confidence._recompute();
        }, 400);
      };
      Confidence._cancelRecomputeDebounced = () => {
        clearTimeout(confidenceTimer);
        confidenceTimer = null;
      };
      Confidence._startupPending = true;
      Confidence._injectBadge();
      Store.subscribe(evt => {
        if (evt?.type === 'sandbox:entered') {
          Confidence._invalidatePending(true);
          return;
        }
        if (evt?.type === 'sandbox:exited') {
          Confidence._invalidatePending();
          return;
        }
        if (evt?.type === 'sandbox:reverted') {
          Confidence._invalidatePending(true);
          return;
        }
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
        if (evt.type !== 'alerts:change') return;
        if (Confidence._suppressedAlertRefreshes > 0) {
          Confidence._suppressedAlertRefreshes--;
          return;
        }
        Confidence._recomputeDebounced();
      }, 'Confidence.autoRecompute');
      Confidence._scheduleStartupRecompute();
    },

    _injectBadge() {
      const actions = document.querySelector('.topbar-actions');
      if (!actions) return;
      const badge = document.createElement('button');
      badge.type = 'button';
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
      // Dismissed alerts still count (dismissing only hides an alert from the bell/drawer/Gantt): score the list
      // BEFORE the dismiss filter. Acknowledged alerts are in it too.
      const { alerts, machines } = Alerts.confidenceInput();
      const rev = Store.rev();
      if (Confidence._lastAlertsSrc === alerts && Confidence._lastRev === rev) return;
      Confidence._lastAlertsSrc = alerts;
      Confidence._lastRev = rev;

      const tasks  = Store.tasksArr;
      if (!tasks.length) { Confidence._apply(100); return; }

      const hMinutes = _confHorizonMinutes();
      const horizonStart = _plantClock();   // the plant clock (I13), not the viewer's

      // The score is computed by the shared formula in nimbus-compute-core.js so the Alert Monitor can never disagree.
      // It needs only the alerts and the plant's machine count (an overloaded day is an 'overload' alert already), so
      // no utilization matrix is computed here any more.
      Confidence._apply(NimbusComputeCore.scoreConfidence({
        alerts, horizonStart, horizonMinutes: hMinutes, machines,
      }).score);
    },

    _apply(score) {
      Confidence._startupPending = false;
      const prev = Confidence._score;
      // The first score of a plant (page load, plant switch: the history is empty) has nothing to differ from: the
      // placeholder 100 is not a previous score, so no "-N" chip flashes for it.
      const hadBaseline = Confidence._history.length > 0;
      Confidence._score = score;
      Confidence._history.push({ ts: Date.now(), score });
      if (Confidence._history.length > 500) Confidence._history.shift();

      // Task 10 (Command Band dark-mode pass): the badge always sits on the
      // fixed-dark --chrome-panel background regardless of the page's own
      // light/dark theme (see the CSS comment above .ni-conf-badge), so its
      // score text must NOT follow the page-theme --ok/--warn-text/--err vars
      // — in light theme those resolve to colors tuned for contrast on a
      // WHITE page, which read as low-contrast against the dark chrome chip.
      // Fixed hex below are brightened tints (same hue/sat as the dark-mode
      // --ok/--warn/--err triad) verified >=4.5:1 against #1f3a5c chrome-panel:
      // ok #4dbd7a 4.88:1, warn #e0a018 5.07:1, err #e88f83 4.78:1.
      const scoreEl = document.getElementById('ni-conf-score');
      if (scoreEl) {
        scoreEl.textContent = score;
        scoreEl.style.color = score >= 80 ? '#4dbd7a' : score >= 50 ? '#e0a018' : '#e88f83';
      }
      const delta = score - prev;
      if (hadBaseline && Confidence._badge && Math.abs(delta) >= 5) {
        const flash = document.createElement('span');
        flash.className = 'ni-conf-delta';
        flash.textContent = delta > 0 ? `+${delta}` : `${delta}`;
        flash.style.color = delta > 0 ? '#4dbd7a' : '#e88f83';
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
      // Fixed dark-safe triad — see the matching comment in _apply() above.
      const scoreEl = document.getElementById('ni-conf-score');
      if (scoreEl) {
        scoreEl.textContent = snap.score;
        scoreEl.style.color = snap.score >= 80 ? '#4dbd7a' : snap.score >= 50 ? '#e0a018' : '#e88f83';
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
      const color = score >= 80 ? '#4ddb9f' : score >= 50 ? '#f0c04a' : '#f08a6a';
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
      // One breakdown at a time: a second click while the matrix is still being fetched (or while the dialog is open)
      // used to stack another modal dialog on top of the first.
      if (breakdownPending || document.querySelector('dialog.ni-breakdown-dlg')) return;
      const { alerts, machines } = Alerts.confidenceInput();   // pre-dismiss list + the plant's machine count, as the badge
      const hMinutes = _confHorizonMinutes();
      const hDays    = Math.ceil(hMinutes / 1440);
      const horizonStart = _plantClock();   // the plant clock (I13), not the viewer's
      const horizonEnd   = new Date(horizonStart.getTime() + hMinutes * 60000);

      // The alerts that carry points (a late or queued order is scored by its due date, so one dated past the horizon
      // can count and a past-due one counts as due now).
      const horizonAlerts = alerts.filter(a => NimbusComputeCore.alertPoints(a, horizonStart, horizonEnd) > 0);
      const errCt  = horizonAlerts.filter(a => a.sev === 'err').length;
      const warnCt = horizonAlerts.filter(a => a.sev === 'warn').length;

      // Fetch matrix using worker when available, fall back to sync
      let matrix = null;
      breakdownPending = true;
      try {
        try {
          matrix = await Utilization.computeMatrixAsync(_plantToday(), hDays, { syncFallback: false });
        } catch {
          matrix = Utilization.computeMatrix(horizonStart, hDays);   // a user clicked the badge: paint, even if it costs a sync compute
        }
      } finally {
        breakdownPending = false;   // everything below is synchronous up to the dialog being in the DOM
      }
      const overloadedLines = {};
      Object.entries(matrix).forEach(([line, lineData]) => {
        let days = 0;
        // The shared overload rule (0.05 h tolerance), as the alert and the Right Now card use: a day filled exactly
        // to capacity is not overloaded.
        Object.values(lineData).forEach(row => { if (row.effectiveCapacity > 0 && NimbusComputeCore.isOverloaded(row.scheduled, row.effectiveCapacity)) days++; });
        if (days > 0) overloadedLines[line] = days;
      });
      const overloadedCount = Object.keys(overloadedLines).length;
      const overloadedLineDays = Object.values(overloadedLines).reduce((s, d) => s + d, 0);
      // The overloaded-line tile shows counts only: its points are already in the Critical tile (each overloaded day is
      // an 'overload' error alert).
      const { errPenalty: errPts, warnPenalty: warnPts } = NimbusComputeCore.scoreConfidence({
        alerts, horizonStart, horizonMinutes: hMinutes, machines,
      });

      const horizonEndLabel = Util.fmtDateShortPref(horizonEnd);

      const _esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

      // Clickable filter tiles (toggle). A tile with nothing behind it is disabled; the active one is aria-pressed.
      let filter = null;   // null | 'err' | 'warn' | 'overload'
      const tile = (key, count, label, sublabel, accent) => `
        <button type="button" class="ni-conf-tile" data-conf-filter="${key}" aria-pressed="${filter === key}"${count > 0 ? '' : ' disabled'}>
          <span class="ni-conf-tile-num" style="color:${count > 0 ? accent : 'var(--fg-mute)'}">${count}</span>
          <span class="ni-conf-tile-lbl">${label}</span>
          <span class="ni-conf-tile-sub">${sublabel || '&nbsp;'}</span>
        </button>`;
      const tilesHtml = () => `
        <div class="ni-conf-tiles">
          ${tile('err', errCt, t(errCt === 1 ? 'ui.critical_conflict' : 'ui.critical_conflicts'), errCt ? t('ui.err_pts', { pts: errPts }) : '', 'var(--err)')}
          ${tile('warn', warnCt, t(warnCt === 1 ? 'ui.warning' : 'ui.warnings'), warnCt && warnPts ? t('ui.err_pts', { pts: warnPts }) : '', 'var(--warn)')}
          ${tile('overload', overloadedCount, t(overloadedCount === 1 ? 'ui.overloaded_line' : 'ui.overloaded_lines'),
                 overloadedCount ? t('ui.conf_days_over', { days: overloadedLineDays, plural: overloadedLineDays > 1 ? 's' : '' }) : '', 'var(--warn)')}
        </div>`;

      const hasAny = errCt || warnCt || overloadedCount;

      const sortedAlerts = [...horizonAlerts].sort((a, b) => (a.time || 0) - (b.time || 0));
      const alertRow = a => `
              <div class="ni-conf-row">
                <span class="ni-conf-dot" style="background:${a.sev==='err'?'var(--err)':'var(--warn)'}"></span>
                <span class="ni-conf-msg">${_esc(a.msgKey ? t(a.msgKey, a.msgVars) : a.msg)}</span>
                <span class="ni-conf-date">${a.time ? Util.fmtDateShortPref(a.time) : ''}</span>
                ${(a.taskId || (a.line && a.time)) ? `<button data-conf-goto="${_esc(a.id)}" class="ni-conf-goto" title="Go to" aria-label="Go to"><span class="ni-conf-goto-arrow">→</span><span class="ni-conf-goto-label">Go to</span></button>` : ''}
              </div>`;
      // Overloaded lines have no single alert to focus, so these rows carry the line name and days only (no Go to).
      const overloadRow = ([line, days]) => `
              <div class="ni-conf-row">
                <span class="ni-conf-dot" style="background:var(--warn)"></span>
                <span class="ni-conf-msg">${_esc(line)}</span>
                <span class="ni-conf-date">${_esc(t('ui.conf_days_over', { days, plural: days > 1 ? 's' : '' }))}</span>
              </div>`;
      const listHtml = () => {
        let title, rows;
        if (filter === 'overload') {
          const entries = Object.entries(overloadedLines).sort((x, y) => y[1] - x[1] || String(x[0]).localeCompare(String(y[0])));
          title = t('ui.conf_filter_overloaded', { count: entries.length });
          rows = entries.map(overloadRow);
        } else if (filter === 'err' || filter === 'warn') {
          const shown = sortedAlerts.filter(a => a.sev === filter);
          title = t(filter === 'err' ? 'ui.conf_filter_critical' : 'ui.conf_filter_warnings', { count: shown.length });
          rows = shown.map(alertRow);
        } else {
          if (!sortedAlerts.length) return '';
          title = t('ui.conf_score_breakdown', { count: sortedAlerts.length });
          rows = sortedAlerts.map(alertRow);
        }
        return `
        <div class="ni-conf-listwrap">
          ${filter ? `<button type="button" class="ni-conf-clear" data-conf-clear>${_esc(t('ui.conf_show_all'))}</button>` : ''}
          <details class="ni-conf-alerts"${filter ? ' open' : ''}>
            <summary>
              <span class="ni-alerts-caret">▶</span>
              <span>${_esc(title)}</span>
            </summary>
            <div class="ni-conf-alerts-list">
              ${rows.join('')}
            </div>
          </details>
        </div>`;
      };
      const dynHtml = () => (hasAny
        ? tilesHtml()
        : `<p style="text-align:center;color:var(--fg-mute);font-size:12.5px;padding:14px 0;margin:0">Schedule looks healthy — no major issues detected.</p>`) + listHtml();

      const cached = Confidence._history;
      const hasHistory = cached.length >= 2;
      const firstTs = hasHistory ? cached[0].ts : null;
      const startLabel = firstTs ? Util.fmtDTShortPref(firstTs) : '';

      const _sc = Confidence._score;
      // Verdict/threshold text triad — theme-driven via --ok/--warn/--err tokens
      // (read live via _cssVar) instead of the old hardcoded hex. This is a
      // separate color decision from the header ring's fixed mockup hex above.
      const _okC   = Confidence._cssVar('--ok',   '#1e7a4a');
      const _warnC = Confidence._cssVar('--warn', '#93610a');
      const _errC  = Confidence._cssVar('--err',  '#b02a20');
      // One set of bands everywhere (badge, ring, this tier, the chart): GOOD >= 80, AT RISK 50-79, CRITICAL < 50.
      const _tier = _sc >= 80 ? { label:'GOOD',     color:_okC,   bg:Confidence._rgba(_okC, 0.15)   }
                  : _sc >= 50 ? { label:'AT RISK',  color:_warnC, bg:Confidence._rgba(_warnC, 0.18)  }
                  :             { label:'CRITICAL', color:_errC,  bg:Confidence._rgba(_errC, 0.18)    };

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
          .ni-breakdown-dlg .ni-conf-tile { padding:10px 12px; border:1px solid var(--line); border-radius:8px; background:var(--bg-subtle); display:flex; flex-direction:column; gap:3px; font:inherit; color:inherit; text-align:left; width:100%; cursor:pointer; transition:border-color .12s, background .12s }
          .ni-breakdown-dlg .ni-conf-tile:hover:not(:disabled) { border-color:var(--fg-mute) }
          .ni-breakdown-dlg .ni-conf-tile:focus-visible { outline:2px solid var(--accent); outline-offset:2px }
          .ni-breakdown-dlg .ni-conf-tile:active:not(:disabled) { background:var(--bg) }
          .ni-breakdown-dlg .ni-conf-tile[aria-pressed="true"] { border-color:var(--accent); box-shadow:0 0 0 1px var(--accent) }
          .ni-breakdown-dlg .ni-conf-tile:disabled { cursor:default; opacity:.6 }
          .ni-breakdown-dlg .ni-conf-listwrap { position:relative }
          .ni-breakdown-dlg .ni-conf-clear { position:absolute; top:12px; right:0; background:none; border:none; padding:0; font-size:11px; color:var(--accent); cursor:pointer; text-decoration:underline }
          .ni-breakdown-dlg .ni-conf-clear:focus-visible { outline:2px solid var(--accent); outline-offset:2px }
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
          <div class="ni-conf-dyn">${dynHtml()}</div>
        </div>`;
      document.body.appendChild(dlg);
      try { dlg.showModal(); } catch { dlg.open = true; }
      if (hasHistory) Confidence._drawChart(dlg.querySelector('#ni-conf-chart'), cached);
      dlg.addEventListener('close', () => dlg.remove());
      dlg.addEventListener('click', e => {
        if (e.target === dlg) { dlg.close(); return; }
        const gotoBtn = e.target.closest('[data-conf-goto]');
        if (gotoBtn) { dlg.close(); if (typeof AlertsUIAdapter !== 'undefined') AlertsUIAdapter.focus(gotoBtn.dataset.confGoto); return; }
        // Tile toggle / Show all: re-render the dynamic region, then hand focus back to the tile that was used.
        const tileBtn = e.target.closest('[data-conf-filter]');
        const clearBtn = !tileBtn && e.target.closest('[data-conf-clear]');
        if (!tileBtn && !clearBtn) return;
        const prev = filter;
        filter = tileBtn ? (filter === tileBtn.dataset.confFilter ? null : tileBtn.dataset.confFilter) : null;
        const dyn = dlg.querySelector('.ni-conf-dyn');
        if (dyn) dyn.innerHTML = dynHtml();
        const focusKey = tileBtn ? tileBtn.dataset.confFilter : prev;
        const again = dlg.querySelector(`[data-conf-filter="${focusKey}"]`);
        if (again && again.focus) again.focus();
      });
    },

    _drawChart(canvas, history) {
      if (!canvas || history.length < 2) return;
      // Size the drawing buffer to the rect the canvas is actually painted at, times the device pixel ratio, and draw
      // in CSS pixels. The fixed 760x240 buffer was stretched to the CSS box (a different aspect ratio), which
      // squashed the dots and text vertically and blurred them on a high-density screen. W and H are CSS px.
      const dpr = window.devicePixelRatio || 1;
      const box = canvas.getBoundingClientRect?.();
      const W = box && box.width  > 0 ? box.width  : 380;
      const H = box && box.height > 0 ? box.height : 120;
      canvas.width  = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      const ctx = canvas.getContext('2d');
      ctx.setTransform?.(dpr, 0, 0, dpr, 0, 0);
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
      const ptColor = s => s >= 80 ? `rgb(${okRgb})` : s >= 50 ? `rgb(${warnRgb})` : `rgb(${errRgb})`;

      // Zone bands
      [{ from:0, to:50, color:`rgba(${errRgb},0.13)` },
       { from:50,to:80, color:`rgba(${warnRgb},0.10)` },
       { from:80,to:100,color:`rgba(${okRgb},0.10)` }
      ].forEach(b => {
        ctx.fillStyle = b.color;
        ctx.fillRect(0, yFor(b.to), W, yFor(b.from) - yFor(b.to));
      });

      // Zone labels (right-aligned, faint)
      ctx.font = 'bold 10px system-ui'; ctx.textAlign = 'right';
      [{ y: yFor(25), label:'CRITICAL', color:`rgba(${errRgb},0.45)` },
       { y: yFor(65), label:'AT RISK',  color:`rgba(${warnRgb},0.4)` },
       { y: yFor(90), label:'GOOD',     color:`rgba(${okRgb},0.4)`  }
      ].forEach(({ y, label, color }) => { ctx.fillStyle = color; ctx.fillText(label, W - 6, y + 5); });

      // Reference lines at the band edges, 50 and 80
      [[50,`rgba(${errRgb},0.55)`],[80,`rgba(${okRgb},0.55)`]].forEach(([v,col]) => {
        ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.setLineDash([5,4]);
        ctx.beginPath(); ctx.moveTo(0, yFor(v)); ctx.lineTo(W, yFor(v)); ctx.stroke();
      });
      ctx.setLineDash([]);

      // Y-axis score labels
      ctx.font = '11px system-ui'; ctx.textAlign = 'left';
      [[50,`rgba(${errRgb},0.65)`],[80,`rgba(${okRgb},0.65)`]].forEach(([v,col]) => {
        ctx.fillStyle = col; ctx.fillText(v, 4, yFor(v) - 3);
      });

      // Pre-compute point positions
      const pts = history.map((p, i) => ({ x: xFor(i), y: yFor(p.score), score: p.score, ts: p.ts }));
      const last = history[history.length - 1].score;
      const lineColor = ptColor(last);
      const fillColor = last >= 80 ? `rgba(${okRgb},0.22)` : last >= 50 ? `rgba(${warnRgb},0.22)` : `rgba(${errRgb},0.22)`;

      // Filled area under line
      ctx.beginPath();
      pts.forEach((p,i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
      ctx.lineTo(pts[pts.length-1].x, H); ctx.lineTo(0, H);
      ctx.closePath(); ctx.fillStyle = fillColor; ctx.fill();

      // Score line with glow
      ctx.shadowColor = lineColor; ctx.shadowBlur = 4;
      ctx.beginPath(); ctx.strokeStyle = lineColor; ctx.lineWidth = 2; ctx.lineJoin = 'round';
      pts.forEach((p,i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Dot at every data point
      pts.forEach((p, i) => {
        const isLast = i === pts.length - 1;
        const col = ptColor(p.score);
        if (isLast) { ctx.shadowColor = col; ctx.shadowBlur = 8; }
        ctx.beginPath();
        ctx.arc(p.x, p.y, isLast ? 4 : 2, 0, Math.PI * 2);
        ctx.fillStyle = col; ctx.fill();
        ctx.strokeStyle = isLast ? '#fff' : '#1a1b1f'; ctx.lineWidth = isLast ? 1.7 : 1; ctx.stroke();
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
        const mx = (e.clientX - rect.left) * (W / (rect.width  || W));
        const my = (e.clientY - rect.top)  * (H / (rect.height || H));
        let nearest = null, minDist = Infinity;
        pts.forEach(p => {
          const d = Math.hypot(p.x - mx, p.y - my);
          if (d < minDist) { minDist = d; nearest = p; }
        });
        const threshold = 20 * (W / (rect.width || W));
        if (nearest && minDist < threshold) {
          const col = `color:${ptColor(nearest.score)}`;
          const timeStr = nearest.ts
            ? Util._fmtTimePref(new Date(nearest.ts))
            : '';
          const dateStr = nearest.ts
            ? Util.fmtDateShortPref(nearest.ts)
            : '';
          tip.innerHTML = `<span style="${col};margin-right:5px">●</span>`
            + `<strong style="${col}">${nearest.score}</strong>`
            + (timeStr ? `<span style="color:var(--fg-mute);font-size:10.5px;margin-left:6px">${dateStr} ${timeStr}</span>` : '');
          tip.style.display = 'block';
          tip.style.left = `${rect.left + nearest.x * ((rect.width  || W) / W)}px`;
          tip.style.top  = `${rect.top  + nearest.y * ((rect.height || H) / H)}px`;
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
  // The pending (80 ms debounced) ghost draw. Kept here, not on the object, so it can be cancelled: a hover that
  // was queued just before Alt was released used to draw ghosts AFTER the key-up had cleared them.
  let rippleShowTimer = null;
  const rippleCancelPending = () => { clearTimeout(rippleShowTimer); rippleShowTimer = null; };
  const RipplePreview = {
    _active: false,
    _ghosts: [],
    _lastId: null,

    init() {
      document.addEventListener('keydown', e => {
        if (e.altKey && !RipplePreview._active) {
          RipplePreview._active = true;
          document.getElementById('vis-timeline')?.classList.add('ripple-mode');
        }
      });
      document.addEventListener('keyup', e => {
        if (!e.altKey) {
          rippleCancelPending();
          RipplePreview._active = false;
          RipplePreview._clearGhosts();
          document.getElementById('vis-timeline')?.classList.remove('ripple-mode');
          RipplePreview._lastId = null;
        }
      });
      // Window losing focus (e.g. Alt+Tab) suppresses keyup, leaving the
      // crosshair cursor stuck on. Force-clear ripple state on blur/hide.
      const _clearRipple = () => {
        rippleCancelPending();
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
        if (!item) {
          // Off every bar: drop the ghosts, a queued draw, and the remembered bar, so coming back to the SAME bar
          // draws its ghosts again instead of being skipped as "unchanged".
          rippleCancelPending();
          RipplePreview._clearGhosts();
          RipplePreview._lastId = null;
          return;
        }
        const id = item.getAttribute('data-id');
        if (id && id !== RipplePreview._lastId) {
          RipplePreview._lastId = id;
          rippleCancelPending();
          rippleShowTimer = setTimeout(() => { rippleShowTimer = null; RipplePreview._show(id); }, 80);
        }
      });
    },

    _show(taskId) {
      if (!RipplePreview._active) return;   // Alt was released while the draw was queued
      RipplePreview._clearGhosts();
      const task = Store.tasks[taskId];
      if (!task?.MACHINE || !task.start_date) return;
      const line = task.MACHINE;
      const peers = Store.tasksArr
        .filter(t => t.MACHINE === line && t.start_date && t.id !== taskId)
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
  // Version 1 snapshots were labelled by selected plant but contained every
  // loaded task. Infer legacy row ownership only from unambiguous evidence.
  function scopeSnapshotTasks(snapshot, plant) {
    const machinePlants = new Map();
    const remember = (machine, owner) => {
      if (!machine || !owner) return;
      if (!machinePlants.has(machine)) machinePlants.set(machine, new Set());
      machinePlants.get(machine).add(owner);
    };
    for (const row of Store.masterData?.lines || []) remember(row.machine, row.plant);
    for (const [machine, settings] of Object.entries(Store.lineSettings || {})) remember(machine, settings.plant);
    for (const task of Store.tasksArr) remember(task.MACHINE, task.PLANT);
    let unknown = 0;
    const tasks = (snapshot.tasks || []).filter(task => {
      let owner = task.PLANT || null;
      if (!owner && snapshot.schemaVersion >= 2) owner = snapshot.plant || null;
      if (!owner) owner = Store.tasks[task.id]?.PLANT || null;
      if (!owner) {
        const owners = machinePlants.get(task.MACHINE);
        if (owners?.size === 1) owner = [...owners][0];
      }
      if (!owner) { unknown++; return false; }
      return owner === plant;
    });
    return { tasks, unknown };
  }

  const Diff = {
    _fmtDate(ms) {
      if (!ms) return '—';
      const d = new Date(ms);
      return Util.fmtDayLabelPref(d) + ' ' + Util._fmtTimePref(d);
    },

    _fmtShort(ms) {
      if (!ms) return '—';
      const d = new Date(ms);
      return Util.fmtDateShortPref(d) + ' · ' + Util._fmtTimePref(d);
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
        MACHINE:  t.MACHINE  || '',
        PRODUCTION_ORDER: t.PRODUCTION_ORDER || live?.PRODUCTION_ORDER || t.id.slice(0, 8),
        text:             t.text             || live?.text              || live?.MATERIAL_DESCRIPTION || '—',
        COLOR:            t.COLOR            || live?.COLOR             || '',
        FORM_SIZE:        t.FORM_SIZE        || live?.FORM_SIZE         || '',
        FIRMED:           t.FIRMED           ?? live?.firmed           ?? false,
        scheduleSegments: t.scheduleSegments,   // undefined on pre-field snapshots (unknown), null = unsplit
      };
    },

    compute(snapTasksA, snapTasksB) {
      const mapA = {}, mapB = {};
      (snapTasksA || []).forEach(t => { mapA[t.id] = Diff._enrich(t); });
      (snapTasksB || []).forEach(t => { mapB[t.id] = Diff._enrich(t); });

      const added   = Object.keys(mapB).filter(id => !mapA[id]).map(id => mapB[id]);
      const removed = Object.keys(mapA).filter(id => !mapB[id]).map(id => mapA[id]);
      const moved   = [];
      const isNum = v => typeof v === 'number' && Number.isFinite(v);
      // undefined on either side = the snapshot predates the field: unknown, never "changed".
      const sameSegments = (a, b) => {
        if (a === undefined || b === undefined) return true;
        if (a === null || b === null) return a === b;
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1]) return false;
        return true;
      };
      Object.keys(mapB).forEach(id => {
        if (!mapA[id]) return;
        const A = mapA[id], B = mapB[id];
        const startDelta   = isNum(A.start_date) && isNum(B.start_date) ? B.start_date - A.start_date : 0;
        const endDelta     = isNum(A.end_date)   && isNum(B.end_date)   ? B.end_date   - A.end_date   : 0;
        const startChanged = isNum(A.start_date) && isNum(B.start_date) ? startDelta !== 0 : A.start_date !== B.start_date;
        const endChanged   = isNum(A.end_date)   && isNum(B.end_date)   ? endDelta   !== 0 : A.end_date   !== B.end_date;
        const lineChanged  = A.MACHINE !== B.MACHINE;
        const segmentsChanged = !sameSegments(A.scheduleSegments, B.scheduleSegments);
        const kinds = [];
        if (startChanged) kinds.push('start');
        // A pure move shifts finish by the same amount as start; only a duration or
        // finish-only change earns the 'finish' kind.
        if (endChanged && (!isNum(A.end_date) || !isNum(B.end_date) || endDelta !== startDelta)) kinds.push('finish');
        if (lineChanged) kinds.push('machine');
        if (segmentsChanged) kinds.push('split');
        if (!kinds.length) return;
        moved.push({
          ...B,
          delta: startDelta,
          startDelta, endDelta, segmentsChanged, kinds,
          lineFrom:    A.MACHINE,
          lineTo:      B.MACHINE,
          lineChanged,
          newStart:    B.start_date,
          oldStart:    A.start_date,
          newEnd:      B.end_date,
          oldEnd:      A.end_date,
        });
      });
      const magnitude = m => Math.max(Math.abs(m.startDelta), Math.abs(m.endDelta));
      moved.sort((a, b) => magnitude(b) - magnitude(a));

      // Line-level summary
      const lineImpact = {};
      const bump = (line, key) => {
        if (!line) return;
        lineImpact[line] = lineImpact[line] || { moved:0, added:0, removed:0 };
        lineImpact[line][key]++;
      };
      moved.forEach(m => { bump(m.lineTo, 'moved'); if (m.lineChanged) bump(m.lineFrom, 'moved'); });
      added.forEach(a => bump(a.MACHINE, 'added'));
      removed.forEach(r => bump(r.MACHINE, 'removed'));

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
        const kinds = (m.kinds || []).map(k => `<span class="ni-diff-kind ${k}">${esc(t('ui.diff_kind_' + k))}</span>`).join('');
        const shift = m.startDelta
          ? `<span class="ni-diff-shift ${dir}">${arrow} ${esc(Diff._fmtDelta(m.delta))}</span>` : '';
        const finish = (m.kinds || []).includes('finish') && m.endDelta
          ? `<span class="ni-diff-finish">${esc(t('ui.diff_finish_delta', { delta: Diff._fmtDelta(m.endDelta) }))}</span>` : '';
        return `<div class="ni-diff-row ni-diff-row-moved">
          <div class="ni-diff-row-top">
            <span class="ni-diff-po">${esc(m.PRODUCTION_ORDER)}</span>
            <span class="ni-diff-desc">${esc(m.text)}</span>
            ${shift}${finish}
          </div>
          <div class="ni-diff-row-bottom">
            ${kinds}${linePart}
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
            <span class="ni-diff-line-chip">${esc(a.MACHINE)}</span>
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
            <span class="ni-diff-line-chip">${esc(r.MACHINE)}</span>
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
      const plant = Store.selectedPlant;

      const snapRows = snaps.slice(-40).reverse().map((s, i) => {
        const badge = s.auto
          ? '<span class="ni-diff-snap-badge auto">auto</span>'
          : '<span class="ni-diff-snap-badge manual">manual</span>';
        const scopedCount = scopeSnapshotTasks(s, plant).tasks.length;
        const taskCt = scopedCount ? `${scopedCount} orders` : '';
        return `<button type="button" class="ni-diff-snap-row${i === 0 ? ' ni-diff-snap-sel' : ''}" aria-pressed="${i === 0}" data-ts="${s.ts}">
          <span class="ni-diff-snap-ago">${TimeMachine._relTime(s.ts)}</span>
          <span class="ni-diff-snap-lbl" title="${Util.escapeHtml(s.label)}">${Util.escapeHtml(s.label)}</span>
          <span style="display:flex;gap:5px;align-items:center">
            <span style="font-size:10px;color:var(--fg-mute)">${taskCt}</span>
            ${badge}
          </span>
        </button>`;
      }).join('');

      dlg.innerHTML = `
        <div style="padding:20px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
            <h3 id="ni-diff-title" style="margin:0;font-size:14px;font-weight:700">${t('cmdp.label_compare_schedules')}</h3>
            <button id="ni-diff-close" aria-label="${t('btn.close')}" style="background:none;border:none;cursor:pointer;font-size:16px;color:var(--fg-mute);padding:2px 6px">✕</button>
          </div>
          <div style="font-size:12px;color:var(--fg-mute);margin-bottom:6px">${t('ui.diff_compare_against')}</div>
          <div class="ni-diff-snaplist" id="ni-diff-snaplist">${snapRows}</div>
          <div class="ni-diff-results" id="ni-diff-out">
            <div style="color:var(--fg-mute);font-size:12.5px;padding:8px 0">${t('intel.select_snapshot')}</div>
          </div>
          <div style="margin-top:14px;text-align:right">
            <button class="btn btn-ghost sm" id="ni-diff-close2">${t('btn.close')}</button>
          </div>
        </div>`;

      dlg.setAttribute('aria-labelledby', 'ni-diff-title');
      document.body.appendChild(dlg);
      try { dlg.showModal(); } catch { dlg.open = true; }
      const unsubscribe = Store.subscribe(evt => {
        if (evt.type === 'plant:selected' && Store.selectedPlant !== plant) dlg.close();
      });
      dlg.addEventListener('close', () => { unsubscribe(); dlg.remove(); });
      dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
      dlg.querySelector('#ni-diff-close').addEventListener('click',  () => dlg.close());
      dlg.querySelector('#ni-diff-close2').addEventListener('click', () => dlg.close());

      const runDiff = ts => {
        const snap = snaps.find(s => s.ts === ts);
        if (!snap) return;
        const curr = Store.tasksForSelectedPlant().map(snapshotTask);
        const historical = scopeSnapshotTasks(snap, plant);
        const d = Diff.compute(historical.tasks, curr);
        const notice = historical.unknown
          ? `<p role="status">${Util.escapeHtml(t('intel.snapshot_scope_unknown', { count: historical.unknown }))}</p>` : '';
        const hasChanges = d.moved.length || d.added.length || d.removed.length;
        // Unknown rows are deliberately omitted, so do not claim identical
        // schedules merely because all known rows happen to match.
        document.getElementById('ni-diff-out').innerHTML = notice
          + (hasChanges || !historical.unknown ? Diff._renderResults(d) : '');
      };

      // Wire up snapshot row clicks
      dlg.querySelectorAll('.ni-diff-snap-row').forEach(row => {
        row.addEventListener('click', () => {
          dlg.querySelectorAll('.ni-diff-snap-row').forEach(r => {
            r.classList.remove('ni-diff-snap-sel'); r.setAttribute('aria-pressed', 'false');
          });
          row.classList.add('ni-diff-snap-sel');
          row.setAttribute('aria-pressed', 'true');
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
  const patternsByPlant = {};   // { [plant]: { 'A→B': count } }; Patterns._pairs is the selected plant's entry
  const Patterns = {
    _LS_KEY:    'nimbus.patterns.v1',
    _pairs:     {},
    _THRESHOLD: 4,

    // The learned colour pairs are per plant (a colour sequence that is habit at one plant says nothing about another),
    // kept as { [plant]: { 'A→B': count } } under the one storage key so the sign-out wipe still clears all of it.
    // A value stored by an older build was one flat { 'A→B': count } map with no plant: it is dropped on load.
    init() {
      try {
        const stored = JSON.parse(localStorage.getItem(Patterns._LS_KEY) || '{}');
        if (stored && typeof stored === 'object') {
          for (const [plant, pairs] of Object.entries(stored))
            if (pairs && typeof pairs === 'object') patternsByPlant[plant] = pairs;
        }
      } catch {}
      Patterns._pairs = patternsByPlant[Store.selectedPlant] || {};
      Store.subscribe(evt => {
        if (evt.type === 'plant:selected') Patterns._pairs = patternsByPlant[Store.selectedPlant] || {};
        if (evt.type === 'task:update' && evt.source === 'timeline' && evt.changes?.start_date)
          Patterns._observe(evt.id);
      });
    },

    _observe(movedId) {
      const plant = Store.selectedPlant;
      const task = Store.tasks[movedId];
      if (!plant || !task?.MACHINE || !task.start_date) return;
      const sorted = Store.tasksArr
        .filter(x => x.MACHINE === task.MACHINE && x.start_date)
        .sort((a,b) => a.start_date - b.start_date);
      const idx = sorted.findIndex(x => x.id === movedId);
      if (idx > 0) {
        const prev = sorted[idx - 1];
        const key  = `${Util.norm(prev.COLOR)}→${Util.norm(task.COLOR)}`;
        const pairs = patternsByPlant[plant] || (patternsByPlant[plant] = {});
        Patterns._pairs = pairs;
        pairs[key] = (pairs[key] || 0) + 1;
        // A full or blocked store must not throw out of a Gantt drag (the count still lives for this session).
        try { localStorage.setItem(Patterns._LS_KEY, JSON.stringify(patternsByPlant)); } catch (e) {
          (window.NIMBUS && window.NIMBUS.ErrorLog
            ? window.NIMBUS.ErrorLog.warn('intel', 'Patterns save failed', { err: String(e), errorCode: 'internal' })
            : console.warn('[Patterns] save failed', e));
        }
        if (pairs[key] === Patterns._THRESHOLD)
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
  // Offline nimbus.theme cache as it was before the first unsaved theme edit (undefined
  // = none pending), so DarkMode.reapply() can restore it after a failed save.
  let themeCachePrev;

  // Repaint canvas-painted views whose colors are baked in at draw time.
  function repaintTheme() {
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
  }

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
      pill.setAttribute('aria-pressed', String(DarkMode.isDark()));
    },

    // Apply a specific theme with write-through: body.dark + the offline nimbus.theme
    // cache (so the pre-network boot picks the right theme) + the durable per-user
    // pref via Session.setPref. Used by both the header pill and the settings control.
    set(isDark, opts = {}) {
      document.body.classList.toggle('dark', !!isDark);
      // Remember the offline cache as it was before the first unsaved edit, so a
      // failed save (reapply below) can put it back even when no pref existed.
      if (themeCachePrev === undefined) {
        try { themeCachePrev = localStorage.getItem(DarkMode._key) || null; } catch { themeCachePrev = null; }
      }
      try { localStorage.setItem(DarkMode._key, isDark ? 'dark' : 'light'); } catch {}
      try { NIMBUS.Session && NIMBUS.Session.setPref && NIMBUS.Session.setPref('theme', isDark ? 'dark' : 'light'); } catch {}
      DarkMode._syncPill();
      if (opts.toast !== false)
        Toast.show(isDark ? t('toast.dark_mode_on') : t('toast.light_mode_on'), 'info', 1200);
      repaintTheme();
    },

    // Re-derive the theme from the saved prefs (user ?? role ?? the cache as it was
    // before an unsaved edit) and bring body.dark, the header pill and the offline
    // cache in line with it. Idempotent. Used after a failed theme save (the Store
    // reverted but the DOM did not) and when Session.refresh() brings a theme saved
    // on another device. Does not toast and does not write the pref.
    reapply() {
      const us = (Store && Store.userSettings) || {}, rd = (Store && Store.roleDefaults) || {};
      let cache = null;
      try { cache = localStorage.getItem(DarkMode._key); } catch {}
      const th = us.theme ?? rd.theme ?? (themeCachePrev !== undefined ? themeCachePrev : cache);
      themeCachePrev = undefined;
      const dark = th === 'dark';
      const changed = dark !== DarkMode.isDark();
      document.body.classList.toggle('dark', dark);
      if (th === 'dark' || th === 'light') { try { localStorage.setItem(DarkMode._key, th); } catch {} }
      DarkMode._syncPill();
      if (changed) repaintTheme();
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
    // Returns false (language unchanged, no reload) when the save failed; the error
    // toast and the settings-pane revert come from Session. Otherwise reloads.
    async set(code) {
      // Durable per-user pref. Await an explicit flush BEFORE reload: setPref is
      // debounced and the reload would otherwise cancel the pending PATCH, leaving
      // the DB (and session cache) stale and reverting the language on next boot.
      try {
        if (NIMBUS.Session && NIMBUS.Session.setPref) {
          NIMBUS.Session.setPref('language', code);
          if (NIMBUS.Session.flushPrefs && (await NIMBUS.Session.flushPrefs()) === false) return false;
        }
      } catch { /* best-effort — the offline cache below still applies the locale */ }
      // Offline render cache — the pre-network boot reads this before Store is
      // hydrated. Written only once the save succeeded, so a failed save never
      // leaves a locale the server does not have.
      try { localStorage.setItem(LangSwitcher._key, code); } catch {}
      location.reload();
      return true;
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

  // Runs the module inits exactly once, whether or not IndexedDB opened. The inits used to sit in a `.then` followed
  // by a `.catch` that ran them AGAIN, so any throw inside the first run (one bad init) doubled every Store
  // subscription and key listener; and one throwing init skipped the ones after it. Each now runs on its own.
  let intelInitDone = false;
  function _initAll() {
    if (intelInitDone) return;
    intelInitDone = true;
    const run = (name, fn) => {
      try { fn(); } catch (e) {
        (window.NIMBUS && window.NIMBUS.ErrorLog
          ? window.NIMBUS.ErrorLog.warn('intel', `${name} init failed`, { err: String(e), errorCode: 'internal' })
          : console.warn(`[NIMBUS.Intelligence] ${name} init failed`, e));
      }
    };
    run('CommandPalette', () => CommandPalette.init());
    run('TimeMachine', () => TimeMachine.init());   // wires the undo:pushed subscription: must run even without IDB
    run('Confidence', () => Confidence.init());
    run('Patterns', () => Patterns.init());
    setTimeout(() => run('RipplePreview', () => RipplePreview.init()), 220);
  }

  function _boot() {
    DarkMode.init();
    NeedsEngine.init();
    IntelDB.open().then(_initAll, e => {
      (window.NIMBUS && window.NIMBUS.ErrorLog
        ? window.NIMBUS.ErrorLog.warn('intel', 'IndexedDB unavailable — continuing without persistence.', { err: String(e), errorCode: 'internal' })
        : console.warn('[NIMBUS.Intelligence] IndexedDB unavailable — continuing without persistence.', e));
      TimeMachine._snapshots = [];
      _initAll();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _boot);
  } else {
    _boot();
  }

})();
