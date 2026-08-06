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

function hook(script, projectDir, stateDir, data, env) {
  return execFileSync(process.execPath, [script], {
    cwd: projectDir,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, LIVE_RULES_STATE_DIR: stateDir, ...env },
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
  assert.match(output, /The manifest does not match the loaded rule files, but these rules were read directly and are in effect\./);
});

test('a template-style manifest entry with priority and include matches its rule', () => {
  const dir = project();
  const rulesDirectory = path.join(dir, '.claude', 'live-rules', 'rules');
  const content = '---\ndescription: Atomic commits & two hats\npriority: 95\n---\nRule body.\n';
  fs.mkdirSync(rulesDirectory, { recursive: true });
  fs.writeFileSync(path.join(rulesDirectory, 'atomic-commits.md'), content);
  fs.writeFileSync(path.join(dir, '.claude', 'live-rules', 'manifest.json'), JSON.stringify({
    version: 1,
    rules: [{
      path: 'rules/atomic-commits.md',
      hash: rules.hashContent(content),
      description: 'Atomic commits & two hats',
      globs: [],
      dirs: [],
      prompt: [],
      priority: 95,
      enabled: true,
      include: [],
    }],
  }) + '\n');

  assert.strictEqual(rules.loadRuleSet(dir).stale, false);
});

test('CRLF atomic rule files retain their LF manifest hash', () => {
  const dir = project();
  const state = path.join(dir, 'state');
  atomic(dir, [{ data: { description: 'Always', priority: 95 }, body: 'Rule body.' }]);
  const target = path.join(dir, '.claude', 'live-rules', 'rules', '001.md');
  fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replace(/\n/g, '\r\n'));

  const output = hook(promptHook, dir, state, { session_id: 'one', prompt: 'hello' });
  assert.match(output, /Rule body/);
  assert.doesNotMatch(output, /The manifest does not match/);
});

test('manifest mismatch warnings name the differing field', () => {
  const dir = project();
  const state = path.join(dir, 'state');
  atomic(dir, [{ data: { description: 'Always', priority: 95 }, body: 'Rule body.' }]);
  const manifestPath = path.join(dir, '.claude', 'live-rules', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.rules[0].priority = 0;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest) + '\n');

  const output = hook(promptHook, dir, state, { session_id: 'one', prompt: 'hello' });
  assert.match(output, /Mismatched manifest fields: rules\/001\.md \(priority\)\./);
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
    assert.doesNotMatch(output, /Live Rules migrated/);
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

test('legacy monolithic files migrate into equivalent atomic files and remove the source', () => {
  const dir = project();
  const legacy = path.join(dir, '.claude', 'live-rules.md');
  fs.writeFileSync(legacy, [
    '---', 'description: Always', '---', 'Always body.',
    '---', 'description: Deploy', 'prompt: [deploy]', '---', 'Deploy body.',
  ].join('\n'));
  assert.strictEqual(rules.migrateLegacyRules(dir), true);
  assert.ok(!fs.existsSync(legacy));
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'live-rules', 'manifest.json'), 'utf8'));
  assert.strictEqual(manifest.rules.length, 2);
  const loaded = rules.loadRuleSet(dir);
  assert.strictEqual(loaded.stale, false);
  assert.deepStrictEqual(rules.selectForPrompt(loaded.rules, { promptText: 'please deploy', cwdRel: '' }).map((entry) => entry.rule.description), ['Always', 'Deploy']);
});

test('SessionStart reports a completed migration once', () => {
  const dir = project();
  const state = path.join(dir, 'state');
  const legacy = path.join(dir, '.claude', 'live-rules.md');
  fs.writeFileSync(legacy, '---\ndescription: Always\n---\nKeep this exact rule.\n');
  const first = hook(startHook, dir, state, { session_id: 'one', source: 'startup' });
  assert.match(first, /Live Rules migrated to \.claude\/live-rules; removed \.claude\/live-rules\.md\./);
  assert.match(first, /Keep this exact rule/);
  assert.ok(!fs.existsSync(legacy));
  const second = hook(startHook, dir, state, { session_id: 'one', source: 'startup' });
  assert.doesNotMatch(second, /Live Rules migrated/);
});

test('a failed migration verification keeps the monolith and names the difference', () => {
  const dir = project();
  const legacy = path.join(dir, '.claude', 'live-rules.md');
  fs.writeFileSync(legacy, '---\ndescription: Always\n---\nKeep this exact rule.\n');
  const result = rules.migrateLegacyRules(dir, {
    detailed: true,
    beforeVerification() {
      fs.writeFileSync(path.join(dir, '.claude', 'live-rules', 'rules', '001.md'), '---\ndescription: Always\n---\nA changed rule.\n');
    },
  });
  assert.strictEqual(result.migrated, false);
  assert.match(result.notice, /kept \.claude\/live-rules\.md because verification failed: rule 1 has different body/);
  assert.ok(fs.existsSync(legacy));
  assert.ok(fs.existsSync(path.join(dir, '.claude', 'live-rules', 'manifest.json')));
});

test('LIVE_RULES_PATH migrations retain their source file', () => {
  const dir = project();
  const state = path.join(dir, 'state');
  const legacy = path.join(dir, 'shared-rules.md');
  fs.writeFileSync(legacy, '---\ndescription: Always\n---\nKeep this shared rule.\n');
  const output = hook(startHook, dir, state, { session_id: 'one', source: 'startup' }, { LIVE_RULES_PATH: legacy });
  assert.match(output, /kept shared-rules\.md because LIVE_RULES_PATH is set/);
  assert.ok(fs.existsSync(legacy));
  assert.ok(fs.existsSync(path.join(dir, '.claude', 'live-rules', 'manifest.json')));
});

test('a failed monolith deletion leaves both copies available for rollback', () => {
  const dir = project();
  const legacy = path.join(dir, '.claude', 'live-rules.md');
  fs.writeFileSync(legacy, 'Rollback rule.\n');
  const remove = fs.rmSync;
  fs.rmSync = (target, options) => {
    if (target === legacy) throw new Error('delete blocked');
    return remove(target, options);
  };
  try {
    const result = rules.migrateLegacyRules(dir, { detailed: true });
    assert.strictEqual(result.migrated, false);
    assert.match(result.notice, /kept \.claude\/live-rules\.md: delete blocked/);
  } finally {
    fs.rmSync = remove;
  }
  assert.ok(fs.existsSync(legacy));
  assert.ok(fs.existsSync(path.join(dir, '.claude', 'live-rules', 'manifest.json')));
});

test('interrupted temp state, an active lock, and future manifests never replace trusted data', () => {
  const dir = project();
  const legacy = path.join(dir, '.claude', 'live-rules.md');
  fs.writeFileSync(legacy, 'Legacy rule.\n');
  fs.mkdirSync(path.join(dir, '.claude', 'live-rules.tmp-interrupted'));
  assert.strictEqual(rules.migrateLegacyRules(dir), true);
  assert.ok(fs.existsSync(path.join(dir, '.claude', 'live-rules.tmp-interrupted')));
  const future = path.join(dir, '.claude', 'live-rules', 'manifest.json');
  fs.writeFileSync(future, JSON.stringify({ version: 99, rules: [] }) + '\n');
  assert.strictEqual(rules.migrateLegacyRules(dir), false);
  assert.strictEqual(JSON.parse(fs.readFileSync(future, 'utf8')).version, 99);
  assert.match(hook(startHook, dir, path.join(dir, 'state'), { session_id: 'future', source: 'startup' }), /newer schema/);
});

test('stale migration locks recover while fresh locks serialize concurrent starts', () => {
  const dir = project();
  fs.writeFileSync(path.join(dir, '.claude', 'live-rules.md'), 'Locked rule.\n');
  const lock = path.join(dir, '.claude', 'live-rules.migration.lock');
  fs.writeFileSync(lock, 'active\n');
  assert.strictEqual(rules.migrateLegacyRules(dir), false);
  const old = new Date(Date.now() - 61 * 1000);
  fs.utimesSync(lock, old, old);
  assert.strictEqual(rules.migrateLegacyRules(dir), true);
});

test('atomic sync repairs a mistyped manifest hash from the rule file', () => {
  const dir = project();
  atomic(dir, [{ data: { description: 'Always' }, body: 'Trust the rule file.' }]);
  const manifestPath = path.join(dir, '.claude', 'live-rules', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.rules[0].hash = 'not-a-sha256';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest) + '\n');

  const repaired = rules.syncAtomicRuleSet(dir);
  assert.match(repaired.rules[0].hash, /^[a-f0-9]{64}$/);
  assert.strictEqual(rules.loadRuleSet(dir).stale, false);
});

test('atomic sync derives changed content and metadata from rule files', () => {
  const dir = project();
  atomic(dir, [{ data: { description: 'Old', globs: ['*.js'] }, body: 'Old body.' }]);
  const target = path.join(dir, '.claude', 'live-rules', 'rules', '001.md');
  fs.writeFileSync(target, '---\ndescription: New\nglobs: ["src/**/*.ts"]\npriority: 4\nenabled: false\ninclude: docs/rules.md\n---\nNew body.\n');

  const manifest = rules.syncAtomicRuleSet(dir);
  assert.deepStrictEqual(manifest.rules[0], {
    path: 'rules/001.md',
    hash: rules.hashContent(fs.readFileSync(path.join(dir, '.claude', 'live-rules', 'rules', '001.md'), 'utf8')),
    description: 'New',
    globs: ['src/**/*.ts'],
    dirs: [],
    prompt: [],
    priority: 4,
    enabled: false,
    include: ['docs/rules.md'],
  });
});

test('atomic sync is stable for unchanged rules and normalizes Windows paths', () => {
  const dir = project();
  atomic(dir, [{ data: { description: 'One' }, body: 'One.' }]);
  const first = rules.syncAtomicRuleSet(dir);
  const before = fs.readFileSync(path.join(dir, '.claude', 'live-rules', 'manifest.json'), 'utf8');
  const second = rules.syncAtomicRuleSet(dir);
  const after = fs.readFileSync(path.join(dir, '.claude', 'live-rules', 'manifest.json'), 'utf8');
  assert.deepStrictEqual(second, first);
  assert.strictEqual(after, before);
  assert.strictEqual(second.rules[0].path, 'rules/001.md');
});

test('atomic sync repairs a partial manifest and fails loudly while another writer holds the lock', () => {
  const dir = project();
  atomic(dir, [{ data: { description: 'One' }, body: 'One.' }]);
  const manifestPath = path.join(dir, '.claude', 'live-rules', 'manifest.json');
  fs.writeFileSync(manifestPath, '{');
  assert.strictEqual(rules.syncAtomicRuleSet(dir).rules.length, 1);

  const lock = path.join(dir, '.claude', 'live-rules.write.lock');
  fs.writeFileSync(lock, 'active\n');
  assert.throws(() => rules.syncAtomicRuleSet(dir), /live-rules\.write\.lock is held.*run live-rules sync again/);
});

test('atomic sync leaves the manifest intact when a partial rule file is invalid', () => {
  const dir = project();
  atomic(dir, [{ data: { description: 'One' }, body: 'One.' }]);
  const manifestPath = path.join(dir, '.claude', 'live-rules', 'manifest.json');
  const before = fs.readFileSync(manifestPath, 'utf8');
  const target = path.join(dir, '.claude', 'live-rules', 'rules', '001.md');
  fs.writeFileSync(target, '---\ndescription: One\n---\nOne.\n---\ndescription: Two\n---\nTwo.\n');

  assert.throws(() => rules.syncAtomicRuleSet(dir), /rules\/001\.md must contain exactly one rule.*run live-rules sync again/);
  assert.strictEqual(fs.readFileSync(manifestPath, 'utf8'), before);
});

test('atomic sync retries after a concurrent rule edit without clobbering it', () => {
  const dir = project();
  atomic(dir, [{ data: { description: 'One' }, body: 'Before.' }]);
  const target = path.join(dir, '.claude', 'live-rules', 'rules', '001.md');
  const manifestPath = path.join(dir, '.claude', 'live-rules', 'manifest.json');
  const originalRename = fs.renameSync;
  let edited = false;
  fs.renameSync = (from, to) => {
    if (!edited && to === manifestPath && String(from).includes('manifest.json.tmp-')) {
      edited = true;
      fs.writeFileSync(target, '---\ndescription: One\n---\nConcurrent update.\n');
    }
    return originalRename(from, to);
  };
  try {
    const manifest = rules.syncAtomicRuleSet(dir);
    assert.strictEqual(edited, true);
    assert.match(fs.readFileSync(target, 'utf8'), /Concurrent update/);
    assert.strictEqual(manifest.rules[0].hash, rules.hashContent(fs.readFileSync(target, 'utf8')));
  } finally {
    fs.renameSync = originalRename;
  }
});

test('failed manifest replacement leaves rule files unchanged and discoverable', () => {
  const dir = project();
  atomic(dir, [{ data: { description: 'One' }, body: 'Before.' }]);
  const target = path.join(dir, '.claude', 'live-rules', 'rules', '001.md');
  const manifestPath = path.join(dir, '.claude', 'live-rules', 'manifest.json');
  const updated = '---\ndescription: One\n---\nStill discoverable.\n';
  fs.writeFileSync(target, updated);
  const originalRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === manifestPath && String(from).includes('manifest.json.tmp-')) throw new Error('simulated rename failure');
    return originalRename(from, to);
  };
  try {
    assert.throws(() => rules.syncAtomicRuleSet(dir), /Could not replace .*manifest.json.*Rule files were left unchanged/);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), updated);
    const loaded = rules.loadRuleSet(dir);
    assert.strictEqual(loaded.rules[0].body, 'Still discoverable.');
    assert.strictEqual(loaded.stale, true);
  } finally {
    fs.renameSync = originalRename;
  }
});
