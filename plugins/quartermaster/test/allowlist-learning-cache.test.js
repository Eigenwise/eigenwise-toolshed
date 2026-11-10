'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { applyLearningCache, learningCacheFile, readLearningCache, refreshLearningCache } = require('../lib/allowlist-learning-cache.js');
const { enablePermissionAutomation } = require('../lib/permission-allowlist.js');
const { slugForProject } = require('../lib/paths.js');
const { appendDecision } = require('../lib/state.js');

const hook = path.join(__dirname, '../hooks/session-start-auto-allowlist.js');

function learningFixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'allowlist-cache-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const environment = { ...process.env, CLAUDE_CONFIG_DIR: path.join(root, 'config'), QUARTERMASTER_STATE_DIR: path.join(root, 'state'), CLAUDE_PROJECT_DIR: project };
  const transcripts = path.join(environment.CLAUDE_CONFIG_DIR, 'projects', slugForProject(project));
  fs.mkdirSync(transcripts, { recursive: true });
  const assistant = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool', name: 'Bash', input: { command: 'git status' } }] } };
  const user = { type: 'user', permissionDecision: { source: 'user' }, message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'done' }] } };
  const transcript = [JSON.stringify({ cwd: project }), ...Array(3).fill(`${JSON.stringify(assistant)}\n${JSON.stringify(user)}`)].join('\n');
  fs.writeFileSync(path.join(transcripts, 'session.jsonl'), transcript);
  return { root, project, environment };
}

function invokeHook(fixture) {
  const result = spawnSync(process.execPath, [hook], { env: fixture.environment, input: JSON.stringify({ source: 'startup', cwd: fixture.project }), encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function forbidTranscriptReads(context) {
  const open = fs.openSync;
  context.mock.method(fs, 'openSync', function (file, ...options) {
    assert.ok(!String(file).endsWith('.jsonl'), 'foreground must not open transcripts');
    return open.call(fs, file, ...options);
  });
}

test('background learning caches proposals without granting permissions; next startup applies them', (context) => {
  const fixture = learningFixture(context);
  enablePermissionAutomation(fixture.project);
  const first = invokeHook(fixture);
  assert.match(first, /^\{"async":true,"asyncTimeout":120000\}\n$/, 'first start hands off asynchronously without reporting additions');
  assert.deepEqual(JSON.parse(first.trim()), { async: true, asyncTimeout: 120000 });
  assert.deepEqual(readLearningCache(fixture.project, fixture.environment).candidates.map((entry) => entry.fingerprint), ['permission:Bash:git status']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.project, '.claude/settings.local.json'))).permissions, undefined);
  const second = invokeHook(fixture);
  assert.match(second, /quartermaster auto-allowlist: added permission:Bash:git status after 3 approvals/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fixture.project, '.claude/settings.local.json'))).permissions.allow, ['Bash(git status:*)']);
});

test('foreground applies populated cache and reads zero transcripts', async (context) => {
  const fixture = learningFixture(context);
  enablePermissionAutomation(fixture.project);
  await refreshLearningCache(fixture.project, fixture.environment);
  forbidTranscriptReads(context);
  assert.equal(applyLearningCache(fixture.project, fixture.environment).additions.length, 1);
  assert.equal(readLearningCache(fixture.project, fixture.environment), null);
});

test('foreground with no cache reads zero transcripts and has no result to print', (context) => {
  const fixture = learningFixture(context);
  enablePermissionAutomation(fixture.project);
  forbidTranscriptReads(context);
  assert.equal(applyLearningCache(fixture.project, fixture.environment), null);
});

test('learning disabled emits nothing and creates no cache', (context) => {
  const fixture = learningFixture(context);
  assert.equal(invokeHook(fixture), '');
  assert.equal(fs.existsSync(learningCacheFile(fixture.project, fixture.environment)), false);
});

test('cached proposals recheck current rejection, plugin installation and opt-in before applying', async (context) => {
  const fixture = learningFixture(context);
  enablePermissionAutomation(fixture.project);
  await refreshLearningCache(fixture.project, fixture.environment);
  appendDecision({ projectDir: fixture.project, kind: 'permission', title: 'allow git status', fingerprint: 'permission:Bash:git status', status: 'rejected' }, fixture.environment);
  const learning = readLearningCache(fixture.project, fixture.environment);
  learning.candidates.push({ fingerprint: 'permission:mcp__plugin_removed_board__claim', approvals: 3 });
  fs.writeFileSync(learningCacheFile(fixture.project, fixture.environment), JSON.stringify(learning));
  const result = applyLearningCache(fixture.project, fixture.environment);
  assert.equal(result.additions.length, 0);
  assert.deepEqual(result.skipped.map((entry) => entry.skipReason), ['rejected in the decision ledger', 'its plugin is no longer installed']);
  await refreshLearningCache(fixture.project, fixture.environment);
  fs.writeFileSync(path.join(fixture.project, '.claude/settings.local.json'), '{}');
  assert.equal(applyLearningCache(fixture.project, fixture.environment).applied, false);
});

test('invalid and cross-project cache contents are ignored', (context) => {
  const fixture = learningFixture(context);
  const file = learningCacheFile(fixture.project, fixture.environment);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const value of ['invalid', '{}', JSON.stringify({ projectPath: fixture.project, candidates: [{}], window: { files: [] } }), JSON.stringify({ projectPath: fixture.project, candidates: [] })]) {
    fs.writeFileSync(file, value);
    assert.equal(readLearningCache(fixture.project, fixture.environment), null);
  }
});
