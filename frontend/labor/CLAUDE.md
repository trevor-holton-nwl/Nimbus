# Labor — pointer

Substantive docs for this domain live at `backend/labor/CLAUDE.md`.

## Utilization matrix (frontend/labor/labor-planning.mts)

Labor reads utilization through `await Utilization.computeMatrixAsync(horizonStart, _horizonSpan * 7)` (horizon 28/56/84/112 days from the viewer-local Monday), in `_renderKPIs` and the line-plan, capacity and exceptions sub-tabs. Results come from the shared per-plant cache (see `frontend/insights/CLAUDE.md`), so a line-checkbox toggle or an alert refresh does not recompute; a data event does, off-thread. `render()` shows the `labor.loading` placeholder, and every await re-checks the `_plantSwitchGeneration` guard (and `_renderKPIs` its own `_kpiGen` + selected plant) so a superseded pass paints nothing. `_renderKPIs` is async; the labor-save acknowledgement path calls it `void`. The async path falls back to the synchronous matrix on a worker failure/timeout.
