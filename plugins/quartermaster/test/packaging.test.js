'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const SHIPPED_DIRECTORIES = ['bin', 'hooks', 'lib'];

function javascriptFilesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.(c?js)$/.test(entry.name))
    .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name));
}

function relativeRequireTargets(file) {
  const source = fs.readFileSync(file, 'utf8');
  return [...source.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)].map((match) => match[1]);
}

// The plugin cache copies plugins/quartermaster/ alone, so a require that climbs out of it loads
// on a repository checkout and throws MODULE_NOT_FOUND for every installed user (GH-261).
test('every relative require in shipped code stays inside the plugin directory', () => {
  const escaping = [];
  for (const directory of SHIPPED_DIRECTORIES) {
    for (const file of javascriptFilesUnder(path.join(PLUGIN_ROOT, directory))) {
      for (const target of relativeRequireTargets(file)) {
        const resolved = path.resolve(path.dirname(file), target);
        if (!resolved.startsWith(PLUGIN_ROOT + path.sep)) escaping.push(`${path.relative(PLUGIN_ROOT, file)} -> ${target}`);
      }
    }
  }
  assert.deepStrictEqual(escaping, []);
});

test('the CLI loads from a copy of the plugin directory shaped like the plugin cache', () => {
  const cacheCopy = fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-cache-'));
  try {
    for (const directory of [...SHIPPED_DIRECTORIES, '.claude-plugin']) {
      fs.cpSync(path.join(PLUGIN_ROOT, directory), path.join(cacheCopy, directory), { recursive: true });
    }
    const result = spawnSync(process.execPath, [path.join(cacheCopy, 'bin', 'quartermaster.js'), '--help'], { encoding: 'utf8' });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /MODULE_NOT_FOUND/);
  } finally {
    fs.rmSync(cacheCopy, { recursive: true, force: true });
  }
});
