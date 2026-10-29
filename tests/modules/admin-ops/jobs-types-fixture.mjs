// The job types exactly as GET /jobs/types serves them (tests/fixtures/jobs_types.json, kept equal to the backend
// registry by tests/test_jobs_contract.py), normalised through the real client. Form tests render from these.
import { readFileSync } from 'node:fs';
import { normType } from '../../../frontend/admin-ops/jobs-client.mjs';

export const RAW_TYPES = JSON.parse(readFileSync(new URL('../../fixtures/jobs_types.json', import.meta.url), 'utf8')).types;
export const TYPES = RAW_TYPES.map(normType);
export const byKey = key => TYPES.find(t => t.key === key);
export const OPT = byKey('optimizer.plant');
