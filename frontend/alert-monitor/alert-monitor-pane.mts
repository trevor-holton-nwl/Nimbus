/* =============================================================================
   ALERT MONITOR PANE — the "Alert Monitor" top-level tab (#alerts-tab).

   STUB (Task 10): only the lifecycle shape lives here so the shell can mount it
   (init once on first entry, render on every entry, setActive(false) on leave —
   the same contract DistributionPane follows). Task 11 fills in the real body.
   ========================================================================== */

let _wired = false;
let _active = false;

export const AlertMonitorPane = {
  init(): void {
    if (_wired) return;
    _wired = true;
  },
  render(): void {
    _active = true;
  },
  setActive(active: boolean): void {
    _active = active;
  },
  isActive(): boolean { return _active; },
};
