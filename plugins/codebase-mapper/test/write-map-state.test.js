'use strict';

const assert = require('node:assert');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const writeMapState = path.join(root, 'scripts', 'write-map-state.js');

function fixtureProject() {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebase-mapper-state-'));
  const mapDir = path.join(projectDir, '.claude', '.codebase-info');
  fs.mkdirSync(mapDir, { recursive: true });
  fs.writeFileSync(path.join(mapDir, 'INDEX.md'), '# Example map\n');
  fs.writeFileSync(path.join(mapDir, 'architecture.md'), '# Architecture\n');
  fs.writeFileSync(path.join(mapDir, 'obsolete.md'), '# Obsolete\n');
  return { projectDir, mapDir };
}

function writeState(projectDir) {
  return childProcess.execFileSync(process.execPath, [writeMapState, '--project', projectDir], { encoding: 'utf8' });
}

function documentHash(mapDir, name) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(mapDir, name), 'utf8').replace(/\r/g, '')).digest('hex');
}

function assertStateMatchesDocuments(mapDir) {
  const state = JSON.parse(fs.readFileSync(path.join(mapDir, '.map-state.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(state.hashes).sort(), ['INDEX.md', ...state.documents].sort());
  for (const name of Object.keys(state.hashes)) assert.strictEqual(state.hashes[name], documentHash(mapDir, name));
  return state;
}

test('write-map-state discovers added and removed documents before atomically replacing state', () => {
  const { projectDir, mapDir } = fixtureProject();
  assert.match(writeState(projectDir), /Wrote map state for 2 document\(s\)\./);
  const firstState = assertStateMatchesDocuments(mapDir);
  assert.strictEqual(firstState.gitCommit, null);
  assert.deepStrictEqual(firstState.documents, ['architecture.md', 'obsolete.md']);

  fs.unlinkSync(path.join(mapDir, 'obsolete.md'));
  fs.writeFileSync(path.join(mapDir, 'modules.md'), '# Modules\n');
  assert.match(writeState(projectDir), /Wrote map state for 2 document\(s\)\./);
  const secondState = assertStateMatchesDocuments(mapDir);
  assert.deepStrictEqual(secondState.documents, ['architecture.md', 'modules.md']);
  assert.ok(!Object.hasOwn(secondState.hashes, 'obsolete.md'));
  assert.strictEqual(secondState.schemaVersion, 1);
  assert.strictEqual(secondState.tool, 'codebase-mapper');
});

test('write-map-state records the current commit in a git project', () => {
  const { projectDir, mapDir } = fixtureProject();
  const git = (args) => childProcess.execFileSync('git', args, { cwd: projectDir, encoding: 'utf8', windowsHide: true });
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Map test']);
  git(['config', 'user.email', 'map-test@example.test']);
  git(['add', '.']);
  git(['commit', '-m', 'Map fixture']);
  const commit = git(['rev-parse', 'HEAD']).trim();

  writeState(projectDir);
  assert.strictEqual(assertStateMatchesDocuments(mapDir).gitCommit, commit);
});
