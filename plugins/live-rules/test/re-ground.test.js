'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const rules = require('../hooks/lib/rules');

const root = path.resolve(__dirname, '..');
const promptHook = path.join(root, 'hooks', 'inject-prompt-rules.js');
const editHook = path.join(root, 'hooks', 'inject-edit-rules.js');
const startHook = path.join(root, 'hooks', 'session-start-rules.js');

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-rules-'));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  return dir;
}

function atomic(projectDir, files) {
  const entries = files.map(({ data, body }) => {
    const rule = rules.buildRule('rule', data, body);
    return { rule, content: '---\n' + Object.entries(data).map(([key, value]) => key + ': ' + (Array.isArray(value) ? JSON.stringify(value) : value)).join('\n') + '\n---\n' + body + '\n' };
  });
  rules.writeAtomicRuleSet(projectDir, entries);
}

function hook(script, projectDir, stateDir, data) {
  return execFileSync(process.execPath, [script], {
    cwd: projectDir,
    env: { ...process.env, LIVE_RULES_STATE_DIR: stateDir },
    input: JSON.stringify({ cwd: projectDir, ...data }),
    encoding: 'utf8',
  });
}

test('unchanged prompts emit no rule content after the first grounding', () => {
  const dir = project();
  const state = path.join(dir, 'state');
  atomic(dir, [{ data: { description: 'Always' }, body: 'First version.' }]);
  assert.match(hook(promptHook, dir, state, { session_id: 'one', prompt: 'hello' }), /First version/);
  assert.strictEqual(hook(promptHook, dir, state, { session_id: 'one', prompt: 'again' }), '');
});

test('only a changed relevant atomic file is re-grounded', () => {
  const dir = project();
  const state = path.join(dir, 'state');
  atomic(dir, [
    { data: { description: 'One' }, body: 'One v1.' },
    { data: { description: 'Two' }, body: 'Two v1.' },
  ]);
  hook(promptHook, dir, state, { session_id: 'one', prompt: 'hello' });
  const changed = path.join(dir, '.claude', 'live-rules', 'rules', '001.md');
  fs.writeFileSync(changed, '---\ndescription: One\n---\nOne v2.\n');
  const output = hook(promptHook, dir, state, { session_id: 'one', prompt: 'hello' });
  assert.match(output, /One v2/);
  assert.doesNotMatch(output, /Two v1/);
});

test('a stale manifest is detected and direct file hashes still re-ground rules', () => {
  const dir = project();
  const state = path.join(dir, 'state');
  atomic(dir, [{ data: { description: 'Always' }, body: 'Version one.' }]);
  const target = path.join(dir, '.claude', 'live-rules', 'rules', '001.md');
  fs.writeFileSync(target, '---\ndescription: Always\n---\nVersion two.\n');
  const output = hook(promptHook, dir, state, { session_id: 'one', prompt: 'hello' });
  assert.match(output, /Version two/);
  assert.match(output, /manifest is stale/);
});

test('session ledgers are isolated across concurrent session ids', () => {
  const dir = project();
  const state = path.join(dir, 'state');
  atomic(dir, [{ data: { description: 'Always' }, body: 'Rule.' }]);
  assert.match(hook(promptHook, dir, state, { session_id: 'first', prompt: 'hello' }), /Rule/);
  assert.match(hook(promptHook, dir, state, { session_id: 'second', prompt: 'hello' }), /Rule/);
  assert.strictEqual(hook(promptHook, dir, state, { session_id: 'first', prompt: 'hello' }), '');
});

test('startup, resume, compact, and clear rehydrate current prompt rules once', () => {
  const dir = project();
  const state = path.join(dir, 'state');
  atomic(dir, [{ data: { description: 'Always' }, body: 'Rule.' }]);
  for (const source of ['startup', 'resume', 'compact', 'clear']) {
    const output = hook(startHook, dir, state, { session_id: 'one', source });
    assert.match(output, new RegExp('SessionStart \\(' + source + '\\)'));
    assert.match(output, /Rule/);
    assert.strictEqual(hook(promptHook, dir, state, { session_id: 'one', prompt: 'hello' }), '');
  }
});

test('path-scoped rules ground once when their edited path first applies', () => {
  const dir = project();
  const state = path.join(dir, 'state');
  atomic(dir, [{ data: { description: 'TypeScript', globs: ['src/**/*.ts'] }, body: 'Use strict types.' }]);
  const data = { session_id: 'one', tool_input: { file_path: 'src/a.ts' } };
  assert.match(hook(editHook, dir, state, data), /Use strict types/);
  assert.strictEqual(hook(editHook, dir, state, data), '');
  assert.strictEqual(hook(editHook, dir, state, { session_id: 'one', tool_input: { file_path: 'other/a.ts' } }), '');
});

test('legacy monolithic files migrate into atomic files without changing selectors', () => {
  const dir = project();
  fs.writeFileSync(path.join(dir, '.claude', 'live-rules.md'), [
    '---', 'description: Always', '---', 'Always body.',
    '---', 'description: Deploy', 'prompt: [deploy]', '---', 'Deploy body.',
  ].join('\n'));
  assert.strictEqual(rules.migrateLegacyRules(dir), true);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'live-rules', 'manifest.json'), 'utf8'));
  assert.strictEqual(manifest.rules.length, 2);
  const loaded = rules.loadRuleSet(dir);
  assert.strictEqual(loaded.stale, false);
  assert.deepStrictEqual(rules.selectForPrompt(loaded.rules, { promptText: 'please deploy', cwdRel: '' }).map((entry) => entry.rule.description), ['Always', 'Deploy']);
});
