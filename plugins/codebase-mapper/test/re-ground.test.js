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

test('startup resume compact and clear each restore the compact index once', () => {
  const directory = project();
  const state = path.join(directory, 'state');
  for (const source of ['startup', 'resume', 'compact', 'clear']) {
    const output = text(hook(startHook, directory, state, { session_id: 'one', source }));
    assert.match(output, new RegExp('SESSIONSTART \\(' + source + '\\)'));
    assert.match(output, /Read focused docs as needed/);
    assert.strictEqual(hook(promptHook, directory, state, { session_id: 'one' }), '');
  }
});

test('existing maps without hashes remain loadable until their next update', () => {
  const directory = project();
  const state = path.join(directory, 'state');
  fs.writeFileSync(path.join(directory, '.claude', '.codebase-info', '.map-state.json'), JSON.stringify({ documents: ['architecture.md', 'modules.md'] }) + '\n');
  const output = text(hook(startHook, directory, state, { session_id: 'one', source: 'startup' }));
  assert.match(output, /no hash manifest yet/);
  assert.strictEqual(hook(promptHook, directory, state, { session_id: 'one' }), '');
});
