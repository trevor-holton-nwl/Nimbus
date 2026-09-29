const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const frontend = path.resolve(__dirname, '../../frontend');

test('literal translation keys used by the frontend exist in English', () => {
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(frontend, 'locales/en.js'), 'utf8'), { window });
  const english = window.__NIMBUS_LOCALES.en;
  const missing = new Set();
  function scan(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { scan(file); continue; }
      if (!/\.(?:js|mts|html)$/.test(entry.name) || file.includes(`${path.sep}locales${path.sep}`)) continue;
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(/(?:Util|NIMBUS\.Util)\.t\s*\(\s*['"]([^'"]+)['"]|data-i18n=['"]([^'"]+)['"]/g)) {
        const key = match[1] || match[2];
        if (!/[.<_]$/.test(key) && !key.includes('<') && !(key in english)) missing.add(key);
      }
    }
  }
  scan(frontend);
  assert.deepEqual([...missing].sort(), []);
});
