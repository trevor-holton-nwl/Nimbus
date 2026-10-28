// Import this FIRST in a test that replays a recorded fixture: the engine reads naive plant wall-clock values
// through local Date getters, so a golden pair is only reproducible in the zone it was recorded in (UTC).
process.env.TZ = 'UTC';
