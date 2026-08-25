'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { applyPermissionAllowlist, enablePermissionAutomation, permissionAutomationEnabled } = require('../lib/permission-allowlist.js');
const { readDecisions } = require('../lib/state.js');
const { slugForProject } = require('../lib/paths.js');

function temporaryProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-allowlist-'));
}

function permissionTranscript(command, outcome = 'approved') {
  const identifier = `tool-${Math.random()}`;
  const assistant = {
    type: 'assistant',
    timestamp: '2026-08-12T12:00:00.000Z',
    message: { content: [{ type: 'tool_use', id: identifier, name: 'Bash', input: { command } }] },
  };
  const user = {
    type: 'user',
    timestamp: '2026-08-12T12:01:00.000Z',
    message: { content: [{ type: 'tool_result', tool_use_id: identifier, content: outcome === 'approved' ? 'done' : 'rejected', is_error: outcome !== 'approved' }] },
    ...(outcome === 'denied' ? { toolDenialKind: 'user-rejected' } : {}),
  };
  return `${JSON.stringify(assistant)}\n${JSON.stringify(user)}\n`;
}

function writeWindow(projectDir, transcripts) {
  const claudeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-claude-'));
  const root = path.join(claudeDirectory, 'projects', slugForProject(projectDir));
  fs.mkdirSync(root, { recursive: true });
  transcripts.forEach((transcript, index) => fs.writeFileSync(path.join(root, `session-${index}.jsonl`), transcript, 'utf8'));
  return { CLAUDE_CONFIG_DIR: claudeDirectory, QUARTERMASTER_STATE_DIR: path.join(claudeDirectory, 'quartermaster-state') };
}

test('always-approved permission fingerprints append project-local allow rules', async () => {
  const projectDir = temporaryProject();
  const settingsFile = path.join(projectDir, '.claude', 'settings.local.json');
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  const before = '{\n  "model": "sonnet",\n  "quartermaster": { "autoApprovePermissions": true },\n  "permissions": {\n    "allow": [\n      "Read"\n    ]\n  }\n}\n';
  fs.writeFileSync(settingsFile, before, 'utf8');
  const environment = writeWindow(projectDir, [
    permissionTranscript('npm test -- --unit'),
    permissionTranscript('npm test -- --integration'),
    permissionTranscript('npm test -- --watch'),
  ]);

  const result = await applyPermissionAllowlist({ projectPath: projectDir, env: environment });
  const after = fs.readFileSync(settingsFile, 'utf8');

  assert.equal(result.additions[0].fingerprint, 'permission:Bash:npm test');
  assert.match(after, /"allow": \[\n      "Read",\n      "Bash\(npm test:\*\)"\n    \]/);
  assert.equal(after.replace(',\n      "Bash(npm test:*)"', ''), before);
  const [decision] = readDecisions(environment);
  assert.deepEqual({
    fingerprint: decision.fingerprint,
    status: decision.status,
    signal: decision.signal,
    detail: decision.detail,
    approvals: decision.approvals,
  }, {
    fingerprint: 'permission:Bash:npm test',
    status: 'applied',
    signal: 'denials',
    detail: 'auto-approved after 3 approvals',
    approvals: 3,
  });
});

test('without the opt-in marker the pass reports candidates and writes nothing', async () => {
  const projectDir = temporaryProject();
  const environment = writeWindow(projectDir, [
    permissionTranscript('npm test -- --unit'),
    permissionTranscript('npm test -- --integration'),
    permissionTranscript('npm test -- --watch'),
  ]);

  const result = await applyPermissionAllowlist({ projectPath: projectDir, env: environment });

  assert.equal(result.applied, false);
  assert.equal(result.additions.length, 0);
  assert.equal(result.eligible[0].fingerprint, 'permission:Bash:npm test');
  assert.equal(fs.existsSync(path.join(projectDir, '.claude', 'settings.local.json')), false);
});

test('a fingerprint with one denial is not added', async () => {
  const projectDir = temporaryProject();
  const environment = writeWindow(projectDir, [
    permissionTranscript('npm run lint'),
    permissionTranscript('npm run lint'),
    permissionTranscript('npm run lint', 'denied'),
    permissionTranscript('npm run lint'),
  ]);

  const result = await applyPermissionAllowlist({ projectPath: projectDir, env: environment });

  assert.equal(result.additions.length, 0);
  assert.equal(fs.existsSync(path.join(projectDir, '.claude', 'settings.local.json')), false);
});

test('denylisted destructive commands never enter the allowlist', async () => {
  const projectDir = temporaryProject();
  const environment = writeWindow(projectDir, Array.from({ length: 100 }, () => permissionTranscript('git reset --hard HEAD')));

  const result = await applyPermissionAllowlist({ projectPath: projectDir, env: environment });

  assert.equal(result.additions.length, 0);
  assert.equal(result.blocked[0].fingerprint, 'permission:Bash:git reset');
  assert.equal(result.blocked[0].vetoReason, 'wildcard would cover destructive siblings');
  assert.equal(result.blocked[0].destructiveCommand, 'git reset --hard HEAD');
  assert.equal(fs.existsSync(path.join(projectDir, '.claude', 'settings.local.json')), false);
});

test('a destructive verb is caught behind a wrapper, not only at the command start', async () => {
  const projectDir = temporaryProject();
  enablePermissionAutomation(projectDir);
  const environment = writeWindow(projectDir, Array.from({ length: 5 }, () => permissionTranscript('sudo rm -rf /var/tmp/build')));

  const result = await applyPermissionAllowlist({ projectPath: projectDir, env: environment });

  assert.equal(result.additions.length, 0);
  assert.equal(result.blocked.length, 1);
});

test('an approved command never earns a rule whose wildcard covers a destructive sibling', async () => {
  const projectDir = temporaryProject();
  enablePermissionAutomation(projectDir);
  const environment = writeWindow(projectDir, Array.from({ length: 5 }, () => permissionTranscript('git push origin main')));

  const result = await applyPermissionAllowlist({ projectPath: projectDir, env: environment });

  assert.equal(result.additions.length, 0, 'Bash(git push:*) would also permit git push --force');
  assert.equal(result.blocked[0].fingerprint, 'permission:Bash:git push');
  assert.equal(result.blocked[0].vetoReason, 'wildcard would cover destructive siblings');
  assert.equal(result.blocked[0].destructiveCommand, null);
});

test('an interpreter never earns a rule, because its wildcard runs arbitrary code', async () => {
  const projectDir = temporaryProject();
  enablePermissionAutomation(projectDir);
  const environment = writeWindow(projectDir, Array.from({ length: 5 }, () => permissionTranscript('node scripts/report.js')));

  const result = await applyPermissionAllowlist({ projectPath: projectDir, env: environment });

  assert.equal(result.additions.length, 0);
  assert.match(result.blocked[0].fingerprint, /^permission:Bash:node\b/);
});

test('enabling automation writes only the project-local opt-in marker', () => {
  const projectDir = temporaryProject();

  assert.equal(enablePermissionAutomation(projectDir), true);
  assert.equal(permissionAutomationEnabled(projectDir), true);
  assert.equal(fs.existsSync(path.join(projectDir, '.claude', 'settings.local.json')), true);
});
