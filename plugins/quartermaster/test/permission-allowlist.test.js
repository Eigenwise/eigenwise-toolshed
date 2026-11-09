'use strict';

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  appendRulesToSettings,
  applyPermissionAllowlist,
  collectPermissionDecisions,
  enablePermissionAutomation,
  fingerprintFor,
  isDestructive,
  normalizedCommandPrefix,
  permissionAutomationEnabled,
  ruleFor,
  ruleTooBroadReason,
} = require('../lib/permission-allowlist.js');
const { appendDecision, readDecisions } = require('../lib/state.js');
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
  const content = outcome === 'hook-blocked'
    ? `PreToolUse:${toolName} hook error: blocked by policy`
    : outcome === 'approved' ? 'done' : 'rejected';
  const user = {
    type: 'user',
    timestamp: '2026-08-12T12:01:00.000Z',
    message: { content: [{ type: 'tool_result', tool_use_id: identifier, content, is_error: outcome !== 'approved' }] },
    ...(outcome === 'denied' ? { toolDenialKind: 'user-rejected' } : {}),
    ...(outcome === 'hook-blocked' ? { toolDenialKind: 'permission-rule' } : {}),
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
  assert.deepEqual(JSON.parse(after), {
    ...JSON.parse(before),
    permissions: { allow: ['Read', 'Bash(npm test:*)'] },
  });
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
  assert.deepEqual(JSON.parse(after), {
    ...JSON.parse(before),
    permissions: { allow: ['Read', 'Bash(npm test:*)'] },
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

test('a fingerprint a PreToolUse hook keeps blocking is excluded from candidates and counted separately', async () => {
  const projectDir = temporaryProject();
  const environment = writeWindow(projectDir, [
    permissionTranscript('npm run lint'),
    permissionTranscript('npm run lint'),
    permissionTranscript('npm run lint'),
    ...Array.from({ length: 32 }, () => permissionTranscript('npm run lint', 'hook-blocked')),
  ]);

  const result = await applyPermissionAllowlist({ projectPath: projectDir, env: environment });

  assert.equal(result.additions.length, 0, 'a hook is actively vetoing this fingerprint; auto-approving it would be pointless');
  assert.equal(result.eligible.length, 0);
  assert.equal(result.hookBlocked, 1);
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

test('a glob argument is vetoed, not written as a dead literal-* rule', async () => {
  const projectDir = temporaryProject();
  enablePermissionAutomation(projectDir);
  const environment = writeWindow(projectDir, Array.from({ length: 3 }, () => permissionTranscript('ls packages/trading-connector/src/*.test.ts')));

  const result = await applyPermissionAllowlist({ projectPath: projectDir, env: environment });
  const after = fs.readFileSync(path.join(projectDir, '.claude', 'settings.local.json'), 'utf8');

  // ruleFor would splice the glob ahead of the `:*` suffix as
  // "Bash(ls packages/trading-connector/src/*.test.ts:*)", a literal-* prefix
  // Claude Code can never match, so the veto keeps any ls rule unwritten.
  assert.equal(result.additions.length, 0);
  assert.equal(result.blocked[0].fingerprint, 'permission:Bash:ls packages/trading-connector/src/*.test.ts');
  assert.equal(result.blocked[0].vetoReason, 'glob argument');
  assert.doesNotMatch(after, /Bash\(ls/);
});

function decidedTranscript(command, { toolName = 'Bash', mode = null, decision = null } = {}) {
  const identifier = `tool-${Math.random()}`;
  const records = mode ? [{ type: 'permission-mode', permissionMode: mode }] : [];
  records.push(
    { type: 'assistant', timestamp: '2026-08-12T12:00:00.000Z', message: { content: [{ type: 'tool_use', id: identifier, name: toolName, input: { command } }] } },
    {
      type: 'user',
      timestamp: '2026-08-12T12:01:00.000Z',
      message: { content: [{ type: 'tool_result', tool_use_id: identifier, content: 'done', is_error: false }] },
      ...(decision ? { permissionDecision: decision } : {}),
    },
  );
  return records.map((record) => `${JSON.stringify(record)}\n`).join('');
}

const USER_APPROVED = { decision: 'accept', source: 'user_temporary', grantScope: 'once' };
const CLASSIFIER_APPROVED = { decision: 'accept', source: 'config', reasonType: 'classifier' };
const MODE_APPROVED = { decision: 'accept', source: 'config', reasonType: 'mode' };

function settingsWithRules(projectDir) {
  const settingsFile = path.join(projectDir, '.claude', 'settings.local.json');
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, '{\n  "quartermaster": { "autoApprovePermissions": true },\n  "permissions": {\n    "allow": ["Read"],\n    "deny": ["Bash(rm:*)"]\n  }\n}\n', 'utf8');
  return settingsFile;
}

test('a fingerprint recorded as rejected is never proposed again and the settings stay byte-identical (GH-469)', async () => {
  const projectDir = temporaryProject();
  const settingsFile = settingsWithRules(projectDir);
  const before = fs.readFileSync(settingsFile);
  const environment = writeWindow(projectDir, Array.from({ length: 5 }, () => decidedTranscript('npm run lint', { decision: USER_APPROVED })));
  appendDecision({ projectDir, kind: 'permission', title: 'allow Bash(npm run:*)', fingerprint: 'permission:Bash:npm run', status: 'rejected' }, environment);

  const result = await applyPermissionAllowlist({ projectPath: projectDir, env: environment });

  assert.equal(result.additions.length, 0);
  assert.equal(result.eligible.length, 0);
  assert.deepEqual(result.skipped.map((entry) => [entry.fingerprint, entry.skipReason]), [['permission:Bash:npm run', 'rejected in the decision ledger']]);
  assert.ok(fs.readFileSync(settingsFile).equals(before), 'a no-op run leaves the existing allow and deny rules byte-identical');
});

test('a tool from a plugin that is no longer installed is skipped, an installed plugin tool is still learned (GH-469)', async () => {
  const projectDir = temporaryProject();
  enablePermissionAutomation(projectDir);
  const environment = writeWindow(projectDir, [
    ...Array.from({ length: 3 }, () => decidedTranscript(undefined, { toolName: 'mcp__plugin_removed_board__claim', decision: USER_APPROVED })),
    ...Array.from({ length: 3 }, () => decidedTranscript(undefined, { toolName: 'mcp__plugin_kept-tools_board__claim', decision: USER_APPROVED })),
  ]);
  const registry = path.join(environment.CLAUDE_CONFIG_DIR, 'plugins', 'installed_plugins.json');
  fs.mkdirSync(path.dirname(registry), { recursive: true });
  fs.writeFileSync(registry, JSON.stringify({ plugins: { 'kept-tools@market': [{ scope: 'user' }] } }), 'utf8');

  const result = await applyPermissionAllowlist({ projectPath: projectDir, env: environment });

  assert.deepEqual(result.additions.map((entry) => entry.fingerprint), ['permission:mcp__plugin_kept-tools_board__claim']);
  assert.deepEqual(result.skipped.map((entry) => [entry.fingerprint, entry.skipReason]), [['permission:mcp__plugin_removed_board__claim', 'its plugin is no longer installed']]);
});

test('approvals the auto-mode classifier or a bypassing mode granted never count as user decisions (GH-481)', async () => {
  const projectDir = temporaryProject();
  const settingsFile = settingsWithRules(projectDir);
  const before = fs.readFileSync(settingsFile);
  const environment = writeWindow(projectDir, [
    ...Array.from({ length: 5 }, () => decidedTranscript('npm run lint', { mode: 'auto', decision: CLASSIFIER_APPROVED })),
    ...Array.from({ length: 5 }, () => decidedTranscript('cargo build', { mode: 'bypassPermissions', decision: MODE_APPROVED })),
    // A host that predates permissionDecision leaves only the session mode.
    ...Array.from({ length: 5 }, () => decidedTranscript('make format', { mode: 'bypassPermissions' })),
    ...Array.from({ length: 5 }, () => decidedTranscript('go vet', { mode: 'auto' })),
  ]);

  const result = await applyPermissionAllowlist({ projectPath: projectDir, env: environment });
  const collected = await collectPermissionDecisions({ projectPath: projectDir, env: environment });

  assert.equal(result.additions.length, 0);
  assert.equal(result.eligible.length, 0);
  for (const entry of collected.decisions) {
    assert.equal(entry.approvals, 0, `${entry.fingerprint} counted an automatic approval as a user decision`);
    assert.equal(entry.automaticApprovals, 5);
  }
  assert.ok(fs.readFileSync(settingsFile).equals(before));
});

test('a user approval counts even inside an auto-mode session, and so does a legacy approval with no recorded source', async () => {
  const projectDir = temporaryProject();
  enablePermissionAutomation(projectDir);
  const environment = writeWindow(projectDir, [
    ...Array.from({ length: 3 }, () => decidedTranscript('npm run lint', { mode: 'auto', decision: USER_APPROVED })),
    ...Array.from({ length: 3 }, () => decidedTranscript('npm run build', { mode: 'default' })),
  ]);

  const result = await applyPermissionAllowlist({ projectPath: projectDir, env: environment });

  assert.deepEqual(result.additions.map((entry) => entry.fingerprint).sort(), ['permission:Bash:npm run']);
  assert.equal(result.additions[0].approvals, 6);
});

test('a session-scoped argument repeated three times in one session earns no rule (GH-457)', async () => {
  const projectDir = temporaryProject();
  enablePermissionAutomation(projectDir);
  const oneSession = [
    "cp 'C:/Users/me/.claude/worktrees/agent-a8f3d5aec089f3c1c/out.json' dist/",
    'cd agent-a8f3d5aec089f3c1c',
    'cat 4f1c2b9e-7d3a-4e8f-9a6b-1c2d3e4f5a6b.log',
  ].flatMap((command) => Array.from({ length: 3 }, () => decidedTranscript(command, { decision: USER_APPROVED }))).join('');
  const environment = writeWindow(projectDir, [oneSession]);

  const result = await applyPermissionAllowlist({ projectPath: projectDir, env: environment });
  const after = fs.readFileSync(path.join(projectDir, '.claude', 'settings.local.json'), 'utf8');

  assert.equal(result.additions.length, 0);
  assert.equal(result.blocked.length, 3);
  for (const entry of result.blocked) {
    assert.equal(entry.vetoReason, 'argument is a file, path, or generated name, not a subcommand', entry.fingerprint);
  }
  assert.doesNotMatch(after, /"allow"/);
});

test('a destructive word inside a quoted search argument is data, not a command (GH-397)', async () => {
  const quotedSearches = [
    'grep -R -n -F "grades the drop magnitude" src/',
    "grep -i 'format string' lib/",
    'rg "kill switch"',
    'git log --grep "truncate"',
    'git commit -m "rm the old fixtures"',
  ];
  for (const command of quotedSearches) {
    assert.equal(isDestructive({ command }), false, command);
  }
  const realDestructive = [
    'drop',
    'rm -rf x',
    'git push --force',
    'git log --oneline rm -f /tmp/log',
    'echo \\"x rm -rf y\\"',
    'grep -F "unterminated rm -rf x',
    'psql app -c "drop table users"',
  ];
  for (const command of realDestructive) {
    assert.equal(isDestructive({ command }), true, command);
  }

  const projectDir = temporaryProject();
  enablePermissionAutomation(projectDir);
  const environment = writeWindow(projectDir, Array.from({ length: 3 }, () => decidedTranscript('git log --grep "truncate the drop magnitude"', { decision: USER_APPROVED })));

  const result = await applyPermissionAllowlist({ projectPath: projectDir, env: environment });

  assert.deepEqual(result.additions.map((entry) => ruleFor(entry.fingerprint)), ['Bash(git log:*)']);
});

test('a quoted separator is data, an escaped quote cannot hide a real one, and unbalanced quotes earn nothing', () => {
  assert.equal(fingerprintFor('Bash', { command: 'git commit -m "first; second | third"' }), 'permission:Bash:git commit');
  assert.equal(fingerprintFor('Bash', { command: 'echo hi \\"; rm -rf ~; \\"' }), null);
  assert.equal(fingerprintFor('Bash', { command: 'git commit -m "unterminated' }), null);
  assert.equal(normalizedCommandPrefix('FOO="a b" npm test -- --unit'), 'npm test');
  assert.equal(normalizedCommandPrefix('A=1 B=2'), null);
});

test('a quoted executable path keeps its quotes in the fingerprint and is refused, never rendered as Blender" (GH-521)', () => {
  const fingerprint = fingerprintFor('Bash', { command: '"/Applications/Blender.app/Contents/MacOS/Blender" --background' });

  assert.equal(fingerprint, 'permission:Bash:"/Applications/Blender.app/Contents/MacOS/Blender"');
  assert.equal(ruleTooBroadReason(fingerprint), 'path-invoked or quoted executable');
  assert.equal(ruleTooBroadReason(fingerprintFor('Bash', { command: '"/Applications/My App/chain.sh" build' })), 'path-invoked or quoted executable');
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
  // Class 6 (GH-521): a rule matches the command as typed, so a path or a
  // quoted executable earns a rule that never matches again.
  ['permission:Bash:"/Applications/Blender.app/Contents/MacOS/Blender"', 'path-invoked or quoted executable'],
  ['permission:Bash:"/Applications/My App/run" build', 'path-invoked or quoted executable'],
  ['permission:Bash:./gradlew build', 'path-invoked or quoted executable'],
  ['permission:Bash:C:\\tools\\fd search', 'path-invoked or quoted executable'],
  // Class 7: a bare executable grants every flag (`curl -T`, `sed -i`,
  // `awk 'BEGIN{system(...)}'`), so no executable is learned without a subcommand.
  ['permission:Bash:ls', 'bare executable without a subcommand'],
  ['permission:Bash:curl', 'bare executable without a subcommand'],
  ['permission:Bash:sed', 'bare executable without a subcommand'],
  ['permission:Bash:awk', 'bare executable without a subcommand'],
  ['permission:Bash:grep', 'bare executable without a subcommand'],
  // Class 8 (GH-457): a file, path, quoted string, or generated name in the
  // subcommand slot pins the rule to one file or one session.
  ['permission:Bash:cat README.md', 'argument is a file, path, or generated name, not a subcommand'],
  ['permission:Bash:cp "src/app/main.js"', 'argument is a file, path, or generated name, not a subcommand'],
  ['permission:Bash:cp \'/tmp/agent-worktree/out.json\'', 'argument is a file, path, or generated name, not a subcommand'],
  ['permission:Bash:cd agent-a8f3d5aec089f3c1c', 'argument is a file, path, or generated name, not a subcommand'],
  ['permission:Bash:cd ..', 'argument is a file, path, or generated name, not a subcommand'],
];

const ALLOWED_FINGERPRINTS = [
  'permission:Bash:npm test',
  'permission:Bash:npm run',
  'permission:Bash:git status',
  'permission:Bash:git log',
  'permission:Bash:cd src',
  'permission:Bash:make build-all',
  'permission:Read',
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

test('learned allow rules preserve deny rules and the default permission mode', () => {
  const projectDir = temporaryProject();
  const settingsFile = path.join(projectDir, '.claude', 'settings.local.json');
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({ permissions: { deny: ['Bash(rm:*)'], defaultMode: 'acceptEdits' } }));

  assert.deepEqual(appendRulesToSettings(projectDir, ['Bash(git status:*)']), ['Bash(git status:*)']);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), {
    permissions: { deny: ['Bash(rm:*)'], defaultMode: 'acceptEdits', allow: ['Bash(git status:*)'] },
  });
});

test('learned allow rules leave sandbox allow arrays untouched across repeated runs', () => {
  const projectDir = temporaryProject();
  const settingsFile = path.join(projectDir, '.claude', 'settings.local.json');
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  const settings = { sandbox: { network: { allow: ['x'] } }, permissions: { allow: ['Read'] } };
  fs.writeFileSync(settingsFile, JSON.stringify(settings));

  assert.deepEqual(appendRulesToSettings(projectDir, ['Bash(git status:*)', 'Bash(git status:*)']), ['Bash(git status:*)']);
  assert.deepEqual(appendRulesToSettings(projectDir, ['Bash(git status:*)']), []);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), {
    ...settings,
    permissions: { allow: ['Read', 'Bash(git status:*)'] },
  });
});

test('learning allow rules refuses invalid JSON without changing the settings file', () => {
  const projectDir = temporaryProject();
  const settingsFile = path.join(projectDir, '.claude', 'settings.local.json');
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  const before = '{"permissions":';
  fs.writeFileSync(settingsFile, before);

  assert.throws(() => appendRulesToSettings(projectDir, ['Bash(git status:*)']), /cannot update invalid JSON/);
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), before);
});
