'use strict';

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  applyPermissionAllowlist,
  enablePermissionAutomation,
  fingerprintFor,
  normalizedCommandPrefix,
  permissionAutomationEnabled,
  ruleFor,
  ruleTooBroadReason,
} = require('../lib/permission-allowlist.js');
const { readDecisions } = require('../lib/state.js');
const { slugForProject } = require('../lib/paths.js');

function temporaryProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-allowlist-'));
}

function permissionTranscript(command, outcome = 'approved', toolName = 'Bash') {
  const identifier = `tool-${Math.random()}`;
  const assistant = {
    type: 'assistant',
    timestamp: '2026-08-12T12:00:00.000Z',
    message: { content: [{ type: 'tool_use', id: identifier, name: toolName, input: { command } }] },
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

test('PowerShell candidates are blocked before reports and settings writes', async () => {
  const projectDir = temporaryProject();
  const settingsFile = path.join(projectDir, '.claude', 'settings.local.json');
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  const before = '{\n  "quartermaster": { "autoApprovePermissions": true },\n  "permissions": {\n    "allow": [\n      "Read"\n    ]\n  }\n}\n';
  fs.writeFileSync(settingsFile, before, 'utf8');
  const environment = writeWindow(projectDir, [
    ...Array.from({ length: 5 }, () => permissionTranscript('Get-ChildItem src', 'approved', 'PowerShell')),
    ...Array.from({ length: 3 }, () => permissionTranscript('npm test -- --unit')),
  ]);

  const result = await applyPermissionAllowlist({ projectPath: projectDir, env: environment });
  const after = fs.readFileSync(settingsFile, 'utf8');
  const output = execFileSync(process.execPath, [path.join(__dirname, '..', 'bin', 'quartermaster.js'), 'allowlist', '--project', projectDir], {
    encoding: 'utf8',
    env: { ...process.env, ...environment },
  });

  assert.deepEqual(result.additions.map((entry) => entry.fingerprint), ['permission:Bash:npm test']);
  assert.deepEqual(result.eligible.map((entry) => entry.fingerprint), ['permission:Bash:npm test']);
  assert.equal(result.blocked[0].fingerprint, 'permission:PowerShell');
  assert.equal(result.blocked[0].vetoReason, 'unsafe shell rule');
  assert.match(output, /blocked permission:PowerShell: vetoed as too broad a rule \(unsafe shell rule\) after 5 approvals/);
  assert.match(after, /"allow": \[\n      "Read",\n      "Bash\(npm test:\*\)"\n    \]/);
  assert.equal(after.replace(',\n      "Bash(npm test:*)"', ''), before);
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

// Representative subset of the offending fingerprints from a field report
// (2026-09-16), one per veto class, plus the existing allowed set to prove
// the new vetoes do not regress it.
const BLOCKED_FINGERPRINTS = [
  // Class 1: shell control keywords as the executable.
  ['permission:Bash:for j', 'shell control keyword'],
  ['permission:Bash:for r', 'shell control keyword'],
  ['permission:Bash:while [', 'shell control keyword'],
  ['permission:Bash:if [', 'shell control keyword'],
  ['permission:Bash:{ echo', 'shell control keyword'],
  ['permission:Bash:(cd', 'shell control keyword'],
  // Class 2: a fingerprint that ends in, or contains, a separator/operator.
  ['permission:Bash:cd "$w";', 'compound command fragment'],
  ['permission:Bash:sleep 240;', 'compound command fragment'],
  ['permission:Bash:pwd &&', 'compound command fragment'],
  ['permission:Bash:echo foo|', 'compound command fragment'],
  ['permission:Bash:tar \\', 'compound command fragment'],
  // Class 2b: a redirection is an operator too, so it vetoes the same way.
  ['permission:Bash:cat >out.txt', 'compound command fragment'],
  ['permission:Bash:tee >>~/.bashrc', 'compound command fragment'],
  ['permission:Bash:sort <input.txt', 'compound command fragment'],
  ['permission:Bash:cat <<EOF', 'compound command fragment'],
  // Class 3: variable-only or empty cd target, and bare variable arguments.
  ['permission:Bash:cd $s', 'variable or empty cd target'],
  ['permission:Bash:cd "$w"', 'variable or empty cd target'],
  ['permission:Bash:cd', 'variable or empty cd target'],
  ['permission:Bash:export $PATH', 'bare shell variable argument'],
  // Class 3b: a command substitution is just as runtime-resolved.
  ['permission:Bash:$(which node)', 'command substitution'],
  ['permission:Bash:`which node`', 'command substitution'],
  ['permission:Bash:echo $(whoami)', 'command substitution'],
  // Class 4: version-pinned plugin cache path, per-session scratchpad path.
  ['permission:Bash:cat ~/.claude/plugins/cache/eigenwise-toolshed/quartermaster/0.11.1/lib/foo.js', 'version-pinned or session-scoped path'],
  ['permission:Bash:cat /tmp/claude-1000/-home-john-project/session-abc/scratchpad/notes.txt', 'version-pinned or session-scoped path'],
  // Class 4b: the version/scratchpad segment itself, the new directory
  // layout, and a case-insensitive match now that the fingerprint keeps case.
  ['permission:Bash:cd ~/.claude/plugins/cache/eigenwise-toolshed/quartermaster/0.11.2', 'version-pinned or session-scoped path'],
  ['permission:Bash:cat ~/.CLAUDE/plugins/cache/eigenwise-toolshed/quartermaster/0.11.1/lib/foo.js', 'version-pinned or session-scoped path'],
  ['permission:Bash:cat /tmp/claude/myproject/session123/scratchpad/notes.txt', 'version-pinned or session-scoped path'],
  // Class 5: a wrapper hides the interpreter, or is bare, or is itself
  // arbitrary execution (`source`, `.`).
  ['permission:Bash:timeout 60', 'arbitrary execution'],
  ['permission:Bash:stdbuf', 'arbitrary execution'],
  ['permission:Bash:nohup node', 'arbitrary execution'],
  ['permission:Bash:nice node', 'arbitrary execution'],
  ['permission:Bash:setsid bash', 'arbitrary execution'],
  ['permission:Bash:command node', 'arbitrary execution'],
  ['permission:Bash:watch node', 'arbitrary execution'],
  ['permission:Bash:source ./script.sh', 'arbitrary execution'],
  ['permission:Bash:. ./script.sh', 'arbitrary execution'],
];

const ALLOWED_FINGERPRINTS = [
  'permission:Bash:npm test',
  'permission:Bash:npm run',
  'permission:Bash:git status',
  'permission:Bash:cat README.md',
  'permission:Bash:cd src',
  'permission:Bash:ls',
];

test('the veto blocks every class of loop keyword, shell fragment, variable target, and pinned path', () => {
  for (const [fingerprint, reason] of BLOCKED_FINGERPRINTS) {
    assert.equal(ruleTooBroadReason(fingerprint), reason, `expected ${fingerprint} to be vetoed as "${reason}"`);
  }
});

test('the veto leaves the existing allowed set alone', () => {
  for (const fingerprint of ALLOWED_FINGERPRINTS) {
    assert.equal(ruleTooBroadReason(fingerprint), null, `expected ${fingerprint} to remain allowed`);
  }
});

test('a compound command earns no fingerprint at all, even when the separator falls outside the kept prefix', () => {
  const compoundCommands = [
    'pwd -P && npm publish',
    'cd build && npm publish',
    'echo one | tee two',
    'sleep 5 & npm publish',
    'ls -la\nnpm publish',
    'cd build\nnpm publish',
    'tar \\',
  ];
  for (const command of compoundCommands) {
    assert.equal(fingerprintFor('Bash', { command }), null, `expected ${JSON.stringify(command)} to yield no fingerprint`);
  }
  // An ordinary command on either side of the check still fingerprints.
  assert.equal(fingerprintFor('Bash', { command: 'npm test -- --unit' }), 'permission:Bash:npm test');
});

test('a mixed-case command keeps its case so the written rule matches it on a case-sensitive host', async () => {
  assert.equal(normalizedCommandPrefix('NPM Test'), 'NPM Test');
  assert.equal(fingerprintFor('Bash', { command: 'NPM Test' }), 'permission:Bash:NPM Test');
  assert.equal(ruleFor('permission:Bash:NPM Test'), 'Bash(NPM Test:*)');
  assert.equal(ruleTooBroadReason('permission:Bash:NPM Test'), null);

  const projectDir = temporaryProject();
  enablePermissionAutomation(projectDir);
  const environment = writeWindow(projectDir, [
    permissionTranscript('NPM Test -- --unit'),
    permissionTranscript('NPM Test -- --integration'),
    permissionTranscript('NPM Test -- --watch'),
  ]);

  const result = await applyPermissionAllowlist({ projectPath: projectDir, env: environment });
  const after = fs.readFileSync(path.join(projectDir, '.claude', 'settings.local.json'), 'utf8');

  assert.equal(result.additions[0].fingerprint, 'permission:Bash:NPM Test');
  assert.match(after, /"Bash\(NPM Test:\*\)"/);
  assert.doesNotMatch(after, /"Bash\(npm test:\*\)"/);
});
