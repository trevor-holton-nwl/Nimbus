import '../helpers/force-utc.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeGolden, encodeGolden, recordGolden } from '../../../scripts/capture-optimizer-golden.mjs';

const fixture = decodeGolden(readFileSync(new URL('../fixtures/optimizer-golden/synthetic-basic.json', import.meta.url), 'utf8'));

// The result only: runtimeMs and similar diagnostics are timing, not outcome.
const outcome = response => ({
  patches: response.candidate.patches,
  status: response.candidate.status,
  searchComplete: response.candidate.searchComplete,
  dispositions: response.candidate.dispositions,
});

test('golden codec round-trips Dates and Sets', () => {
  const value = { when: new Date('2035-08-06T08:00:00Z'), ids: new Set(['a', 'b']), nested: [{ end: new Date('2035-08-07T00:00:00Z') }] };
  assert.deepEqual(decodeGolden(encodeGolden(value)), value);
});

test('the checked-in synthetic pair replays to the recorded patches', async () => {
  assert.equal(process.env.TZ, 'UTC');
  const replay = await recordGolden(fixture.request);
  assert.equal(replay.response.error, undefined);
  assert.deepEqual(outcome(replay.response), outcome(fixture.response));
  assert.equal(replay.response.candidate.patches.length, 4, 'every order of the fixture is placed');
  assert.ok(replay.response.validation, 'the response carries the serialized validation metadata');
});
