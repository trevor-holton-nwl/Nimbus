# Master Data — pointer

Substantive docs for this domain live at `backend/master_data/CLAUDE.md`.

`MaterialGrids.setQuickFilter(which, text)` (`material-grids.mts`) sets a grid's quick-filter text from code: applied at once when the grid is ready, else kept and applied in `onGridReady` (the Alert Monitor's routing-gap cards call it right after `App.gotoMasterSub('routing-pv')`).

Master Data > Plant has a fourth inner tab, **Calendar** (`data-plant-tab="calendar"`; both `gotoTab` literals in `admin-ui.mts` carry it), owned by `frontend/calendar/calendar-periods-ui.mts` (see `frontend/calendar/CLAUDE.md`). The Working Hours panel moved there (now "Default week"), and so did Plant Blackouts (2026-10-19: editable, planner-writable, marked on the period timeline); General keeps the Production Lines roster.
