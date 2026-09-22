'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const { enablePermissionAutomation } = require('../lib/permission-allowlist.js');
const { slugForProject } = require('../lib/paths.js');

const HOOK = path.join(__dirname, '..', 'hooks', 'session-start-auto-allowlist.js');

function permissionTranscript(command) {
  const identifier = `tool-${Math.random()}`;
  const assistant = {
    type: 'assistant',
    timestamp: '2026-08-12T12:00:00.000Z',
    message: { content: [{ type: 'tool_use', id: identifier, name: 'Bash', input: { command } }] },
  };
  const user = {
    type: 'user',
    timestamp: '2026-08-12T12:01:00.000Z',
    message: { content: [{ type: 'tool_result', tool_use_id: identifier, content: 'done', is_error: false }] },
  };
  return `${JSON.stringify(assistant)}\n${JSON.stringify(user)}\n`;
}

function runHook(projectDir, commands) {
  const claudeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-hook-claude-'));
  const root = path.join(claudeDirectory, 'projects', slugForProject(projectDir));
  fs.mkdirSync(root, { recursive: true });
  commands.forEach((command, index) => fs.writeFileSync(path.join(root, `session-${index}.jsonl`), permissionTranscript(command), 'utf8'));
  const environment = { CLAUDE_CONFIG_DIR: claudeDirectory, QUARTERMASTER_STATE_DIR: path.join(claudeDirectory, 'quartermaster-state') };
  enablePermissionAutomation(projectDir);
  const result = spawnSync(process.execPath, [HOOK], {
    env: { ...process.env, ...environment, CLAUDE_PROJECT_DIR: projectDir },
    input: JSON.stringify({ source: 'startup', cwd: projectDir }),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('a rule vetoed as too broad reports its own reason, not a generic destructive claim', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-hook-project-'));
  const stdout = runHook(projectDir, Array.from({ length: 5 }, () => 'cd $TARGET'));

  assert.match(stdout, /blocked permission:Bash:cd \$TARGET because variable or empty cd target/);
  assert.doesNotMatch(stdout, /because it is destructive/);
});

test('a sighted destructive command with no rule-broadness veto still falls back to the generic message', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-hook-project-'));
  // `grep pkill ...` fingerprints as `permission:Bash:grep pkill`, which no
  // too-broad rule matches, but the full command still sights the standalone
  // destructive verb `pkill`, so it is blocked with no vetoReason at all.
  const stdout = runHook(projectDir, Array.from({ length: 5 }, () => 'grep pkill /var/log/syslog'));

  assert.match(stdout, /blocked permission:Bash:grep pkill because it is destructive/);
});
