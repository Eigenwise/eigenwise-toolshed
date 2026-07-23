'use strict';

const assert = require('node:assert');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const documents = require('../hooks/lib/map-documents');

const root = path.resolve(__dirname, '..');
const promptHook = path.join(root, 'hooks', 'remind.js');
const startHook = path.join(root, 'hooks', 'inject-context.js');

function project() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codebase-mapper-'));
  const mapDirectory = path.join(directory, '.claude', '.codebase-info');
  fs.mkdirSync(mapDirectory, { recursive: true });
  fs.writeFileSync(path.join(mapDirectory, 'INDEX.md'), '# Example map\n\nRead focused docs as needed.\n');
  fs.writeFileSync(path.join(mapDirectory, 'architecture.md'), '# Architecture\n\nVersion one.\n');
  fs.writeFileSync(path.join(mapDirectory, 'modules.md'), '# Modules\n\nVersion one.\n');
  writeState(directory);
  return directory;
}

function writeState(projectDir) {
  const map = documents.loadMap(projectDir);
  fs.writeFileSync(path.join(projectDir, '.claude', '.codebase-info', '.map-state.json'), JSON.stringify({
    tool: 'codebase-mapper',
    version: '2.2.0',
    documents: map.documents.filter((entry) => entry.relative !== 'INDEX.md').map((entry) => entry.relative),
    hashes: documents.mapHashes(map.documents),
  }, null, 2) + '\n');
}

function hook(script, projectDir, stateDirectory, data) {
  return childProcess.execFileSync(process.execPath, [script], {
    cwd: projectDir,
    env: { ...process.env, CODEBASE_MAPPER_STATE_DIR: stateDirectory },
    input: JSON.stringify({ cwd: projectDir, ...data }),
    encoding: 'utf8',
  });
}

function text(output) {
  return JSON.parse(output).hookSpecificOutput.additionalContext;
}

test('unchanged prompts are silent after session grounding', () => {
  const directory = project();
  const state = path.join(directory, 'state');
  assert.match(text(hook(startHook, directory, state, { session_id: 'one', source: 'startup' })), /INDEX\.md/);
  assert.strictEqual(hook(promptHook, directory, state, { session_id: 'one' }), '');
});

test('one changed map document names only that document to reread', () => {
  const directory = project();
  const state = path.join(directory, 'state');
  hook(startHook, directory, state, { session_id: 'one', source: 'startup' });
  fs.writeFileSync(path.join(directory, '.claude', '.codebase-info', 'architecture.md'), '# Architecture\n\nVersion two.\n');
  const output = text(hook(promptHook, directory, state, { session_id: 'one' }));
  assert.match(output, /architecture\.md/);
  assert.doesNotMatch(output, /modules\.md/);
  assert.doesNotMatch(output, /Version two/);
  assert.strictEqual(hook(promptHook, directory, state, { session_id: 'one' }), '');
});

test('a changed index is re-grounded without loading focused documents', () => {
  const directory = project();
  const state = path.join(directory, 'state');
  hook(startHook, directory, state, { session_id: 'one', source: 'startup' });
  fs.writeFileSync(path.join(directory, '.claude', '.codebase-info', 'INDEX.md'), '# Updated map\n');
  const output = text(hook(promptHook, directory, state, { session_id: 'one' }));
  assert.match(output, /INDEX\.md/);
  assert.doesNotMatch(output, /architecture\.md/);
});

test('stale map hashes never hide a manual edit', () => {
  const directory = project();
  const state = path.join(directory, 'state');
  hook(startHook, directory, state, { session_id: 'one', source: 'startup' });
  fs.writeFileSync(path.join(directory, '.claude', '.codebase-info', 'modules.md'), '# Modules\n\nManual edit.\n');
  const output = text(hook(promptHook, directory, state, { session_id: 'one' }));
  assert.match(output, /modules\.md/);
  assert.match(output, /hash manifest is stale/);
});

test('concurrent sessions keep independent map ledgers', () => {
  const directory = project();
  const state = path.join(directory, 'state');
  hook(startHook, directory, state, { session_id: 'first', source: 'startup' });
  hook(startHook, directory, state, { session_id: 'second', source: 'startup' });
  fs.writeFileSync(path.join(directory, '.claude', '.codebase-info', 'architecture.md'), '# Architecture\n\nVersion two.\n');
  assert.match(text(hook(promptHook, directory, state, { session_id: 'first' })), /architecture\.md/);
  assert.match(text(hook(promptHook, directory, state, { session_id: 'second' })), /architecture\.md/);
});

test('SessionStart scopes re-grounding to its source and preserves seen documents', () => {
  const directory = project();
  const state = path.join(directory, 'state');
  const startup = text(hook(startHook, directory, state, { session_id: 'one', source: 'startup' }));
  assert.match(startup, /SESSIONSTART \(startup\)/);
  assert.match(startup, /Read focused docs as needed/);
  assert.match(startup, /Before anything else in your first reply/);
  assert.match(startup, /Codebase map: read <doc\(s\)>/);
  assert.match(startup, /Codebase map: no read needed - <reason>/);
  assert.match(startup, /This is mandatory; do not silently skip it/);
  assert.match(startup, /only relevant map document\(s\)/);
  assert.match(startup, /Never re-read a document already read this session unless this hook names it as changed/);
  assert.strictEqual(hook(promptHook, directory, state, { session_id: 'one' }), '');

  assert.strictEqual(hook(startHook, directory, state, { session_id: 'one', source: 'resume' }), '');

  fs.writeFileSync(path.join(directory, '.claude', '.codebase-info', 'architecture.md'), '# Architecture\n\nVersion two.\n');
  const compact = text(hook(startHook, directory, state, { session_id: 'one', source: 'compact' }));
  assert.match(compact, /SESSIONSTART \(compact\)/);
  assert.match(compact, /Read focused docs as needed/);
  assert.match(compact, /Before anything else in your first reply/);
  assert.match(compact, /Codebase map: read <doc\(s\)>/);
  assert.match(compact, /Codebase map: no read needed - <reason>/);
  const changedAfterCompact = text(hook(promptHook, directory, state, { session_id: 'one' }));
  assert.match(changedAfterCompact, /architecture\.md/);

  fs.writeFileSync(path.join(directory, '.claude', '.codebase-info', 'architecture.md'), '# Architecture\n\nVersion three.\n');
  const resumedChange = text(hook(startHook, directory, state, { session_id: 'one', source: 'resume' }));
  assert.match(resumedChange, /SessionStart \(resume\)/);
  assert.match(resumedChange, /architecture\.md/);
  assert.doesNotMatch(resumedChange, /modules\.md/);
});

test('legacy maps gain a hash manifest on SessionStart without changing documents', () => {
  const directory = project();
  const state = path.join(directory, 'state');
  const statePath = path.join(directory, '.claude', '.codebase-info', '.map-state.json');
  const before = fs.readFileSync(path.join(directory, '.claude', '.codebase-info', 'architecture.md'), 'utf8');
  fs.writeFileSync(statePath, JSON.stringify({ documents: ['architecture.md', 'modules.md'] }) + '\n');
  const output = text(hook(startHook, directory, state, { session_id: 'one', source: 'startup' }));
  assert.match(output, /INDEX\.md/);
  const migrated = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.strictEqual(migrated.schemaVersion, 1);
  assert.deepStrictEqual(migrated.hashes, documents.mapHashes(documents.loadMap(directory).documents));
  assert.strictEqual(fs.readFileSync(path.join(directory, '.claude', '.codebase-info', 'architecture.md'), 'utf8'), before);
  assert.ok(fs.existsSync(statePath + '.legacy.json'));
});

test('current maps no-op while future state and interrupted temps stay untouched', () => {
  const directory = project();
  const statePath = path.join(directory, '.claude', '.codebase-info', '.map-state.json');
  const current = fs.readFileSync(statePath, 'utf8');
  assert.strictEqual(documents.migrateLegacyMap(directory), false);
  assert.strictEqual(fs.readFileSync(statePath, 'utf8'), current);
  fs.writeFileSync(statePath, JSON.stringify({ schemaVersion: 99, hashes: {} }) + '\n');
  fs.writeFileSync(statePath + '.tmp-interrupted', 'partial\n');
  assert.strictEqual(documents.migrateLegacyMap(directory), false);
  assert.strictEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')).schemaVersion, 99);
  assert.match(text(hook(startHook, directory, path.join(directory, 'state'), { session_id: 'future', source: 'startup' })), /newer schema/);
  assert.ok(fs.existsSync(statePath + '.tmp-interrupted'));
});

test('stale map migration locks recover while fresh locks serialize concurrent starts', () => {
  const directory = project();
  const statePath = path.join(directory, '.claude', '.codebase-info', '.map-state.json');
  fs.writeFileSync(statePath, JSON.stringify({ documents: ['architecture.md', 'modules.md'] }) + '\n');
  const lock = path.join(directory, '.claude', '.codebase-info.migration.lock');
  fs.writeFileSync(lock, 'active\n');
  assert.strictEqual(documents.migrateLegacyMap(directory), false);
  const old = new Date(Date.now() - 61 * 1000);
  fs.utimesSync(lock, old, old);
  assert.strictEqual(documents.migrateLegacyMap(directory), true);
  assert.strictEqual(documents.migrateLegacyMap(directory), false);
});
