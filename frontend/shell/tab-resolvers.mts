// shell/tab-resolvers.mjs — the "am I currently the visible tab/sub-tab?"
// injected getter seam, extracted verbatim from plant-and-administration.mts
// (Phase P2 of docs/architecture/domain-refactor-plan.md) so master-data's
// `Plant` and labor's `LaborPlanning` can each ask that question without a
// bare reference to `App` (application-shell.mts). Wired once from app.js
// boot glue immediately after the CQ-1 bridge destructure. Defaults are
// no-ops so a call before wiring (e.g. in a unit test that imports a
// consumer module directly) never throws.
interface ActiveTabResolvers {
  currentTab(): string | null;
  currentMasterSub(): string | null;
  laborSub(): string | null;
}

let _activeTabResolvers: ActiveTabResolvers = { currentTab: () => null, currentMasterSub: () => null, laborSub: () => null };

export function setActiveTabResolvers(resolvers: Partial<ActiveTabResolvers>): void {
  _activeTabResolvers = { ..._activeTabResolvers, ...resolvers };
}

/** Accessor for consumers (`Plant`, `LaborPlanning`) — safer/more explicit
 *  than exporting the mutable `let` binding directly for live-binding
 *  re-export across modules. */
export function getActiveTabResolvers(): ActiveTabResolvers {
  return _activeTabResolvers;
}

export type { ActiveTabResolvers };
