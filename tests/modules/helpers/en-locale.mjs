// Loads frontend/locales/en.js (a classic script that fills window.__NIMBUS_LOCALES) so a test that asserts planner-facing
// English can read it through Util.t(), which otherwise returns the bare key when no locale is installed.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let cached = null;
export function enLocale() {
  if (!cached) {
    const sandbox = { window: {} };
    vm.runInNewContext(readFileSync(new URL('../../../frontend/locales/en.js', import.meta.url), 'utf8'), sandbox);
    cached = sandbox.window.__NIMBUS_LOCALES;
  }
  return cached;
}
