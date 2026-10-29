// Import FIRST in a headless test: the plant under test (America/Chicago) is the process zone, as in production
// (the Jobs runner starts the Node child with TZ=<plant timezone>). The engine reads naive plant wall-clock values
// through local Date getters.
process.env.TZ = 'America/Chicago';
