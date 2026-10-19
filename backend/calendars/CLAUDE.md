# Calendars — pointer

Substantive docs for this domain live at `frontend/calendar/CLAUDE.md`.

The sixth endpoint, `POST /plant-calendar/plant-periods` (effective-dated plant calendar periods), is documented there too.

`POST /plant-calendar/plant-blackouts` is planner-writable (signed-in user whose `role_plants` scope covers the plant, through `_calendar_plant_guard`); the other four write routes stay `require_admin`. Details in the frontend file above. Its data functions live in `master_data.py`, not in this folder: `save_plant_periods`, `load_plant_periods`, `active_work_hours`, `_period_overlaps`.
