// V-M2-08: optimizer-worker.mjs is loaded only by a Worker in production. Importing it anywhere else must stay inert:
// no document, no worker realm (this process) and a page realm (document present) must never get a message handler.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const workerUrl = pathToFileURL(resolve('frontend/optimization/optimizer-worker.mjs')).href;

function inFreshRealm(setup) {
  const script = `
    ${setup}
    const mod = await import(${JSON.stringify(workerUrl)});
    console.log(JSON.stringify({
      exports: Object.keys(mod).sort(),
      hasOnmessage: typeof globalThis.onmessage === 'function',
    }));
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout.trim().split('\n').at(-1));
}

test('V-M2-08: importing the worker module with no document and no worker realm installs nothing', async () => {
  assert.equal(typeof globalThis.document, 'undefined', 'this process has no document');
  const mod = await import('../../../frontend/optimization/optimizer-worker.mjs');
  assert.equal(typeof mod.buildOptimizerWorkerResponse, 'function');
  assert.equal(typeof mod.installOptimizerWorkerHandler, 'function');
  assert.equal(typeof globalThis.onmessage, 'undefined', 'no handler leaked into the importing realm');
});

test('V-M2-08: a page realm (document present) never installs the handler, even when postMessage exists', () => {
  const result = inFreshRealm(`
    globalThis.document = {};
    globalThis.postMessage = () => {};
    globalThis.NimbusComputeCore = {};
  `);
  assert.equal(result.hasOnmessage, false);
  assert.ok(result.exports.includes('installOptimizerWorkerHandler'));
});

test('V-M2-08: a worker realm (postMessage, no document) installs the handler synchronously on import', () => {
  const result = inFreshRealm(`
    globalThis.postMessage = () => {};
    globalThis.NimbusComputeCore = {};
  `);
  assert.equal(result.hasOnmessage, true, 'onmessage is assigned during the import, before the first request can arrive');
});
