'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const { slugForProject } = require('../lib/paths.js');
const { recordSessionTally } = require('../lib/state.js');

const CLI = path.resolve(__dirname, '../bin/quartermaster.js');

function run(command, projectPath, environment = {}) {
  const argumentsForCommand = Array.isArray(command) ? command : [command];
  return spawnSync(process.execPath, [CLI, ...argumentsForCommand, '--project', projectPath], {
    encoding: 'utf8',
    env: { ...process.env, ...environment },
  });
}

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

function permissionEnvironment(projectPath, commands) {
  const claudeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-cli-claude-'));
  const root = path.join(claudeDirectory, 'projects', slugForProject(projectPath));
  fs.mkdirSync(root, { recursive: true });
  commands.forEach((command, index) => fs.writeFileSync(path.join(root, `session-${index}.jsonl`), permissionTranscript(command), 'utf8'));
  return { CLAUDE_CONFIG_DIR: claudeDirectory, QUARTERMASTER_STATE_DIR: path.join(claudeDirectory, 'quartermaster-state') };
}

function jsonReport(result) {
  const start = result.stdout.indexOf('{\n');
  assert.notEqual(start, -1, result.stdout);
  return JSON.parse(result.stdout.slice(start));
}

function blockedEntryLines(output) {
  return output.split('\n').filter((line) => line.startsWith('blocked permission:'));
}

test('the retired mark-retro command stays unavailable', () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-cli-test-'));

  const retired = run('mark-retro', projectPath);
  assert.notEqual(retired.status, 0);
  assert.match(retired.stderr, /Unknown command: mark-retro/);

  const current = run('mark-resupply', projectPath);
  assert.equal(current.status, 0, current.stderr);
  assert.equal(JSON.parse(current.stdout).ok, true);
});

test('decline-resupply records the decline and clears the current accumulation', () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-cli-test-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-state-test-'));
  const environment = { QUARTERMASTER_STATE_DIR: stateDir };
  for (let index = 0; index < 4; index += 1) {
    recordSessionTally(projectPath, `session-${index}`, { prompts: 4, toolCalls: 8 }, environment);
  }

  const declined = run('decline-resupply', projectPath, environment);
  assert.equal(declined.status, 0, declined.stderr);
  assert.ok(JSON.parse(declined.stdout).lastDeclinedAt);

  const status = run('status', projectPath, environment);
  assert.equal(status.status, 0, status.stderr);
  const parsedStatus = JSON.parse(status.stdout);
  assert.equal(parsedStatus.unanalyzedSessions, 0);
  assert.ok(parsedStatus.lastDeclinedAt);
});

test('allowlist summarizes large blocked sets and caps requested details', () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-cli-test-'));
  const commands = Array.from({ length: 30 }, (_, index) => {
    const label = String(index).padStart(2, '0');
    return Array.from({ length: 3 }, () => `safe-${label} list; rm -rf /tmp/quartermaster-${label}`);
  }).flat();
  const environment = permissionEnvironment(projectPath, commands);

  const summarized = run(['allowlist', '--sessions', '100'], projectPath, environment);
  assert.equal(summarized.status, 0, summarized.stderr);
  assert.match(summarized.stdout, /blocked 30 fingerprints by tool \(Bash: 30\)/);
  assert.equal(blockedEntryLines(summarized.stdout).length, 5);
  const summarizedReport = jsonReport(summarized);
  assert.equal(summarizedReport.blocked.total, 30);
  assert.equal(summarizedReport.blocked.byTool.Bash, 30);
  assert.equal(summarizedReport.blocked.top.length, 5);
  assert.equal(summarizedReport.blocked.details, undefined);

  const detailed = run(['allowlist', '--sessions', '100', '--blocked'], projectPath, environment);
  assert.equal(detailed.status, 0, detailed.stderr);
  assert.equal(blockedEntryLines(detailed.stdout).length, 25);
  assert.match(detailed.stdout, /blocked detail capped at 25; 5 more omitted/);
  const detailedReport = jsonReport(detailed);
  assert.equal(detailedReport.blocked.details.length, 25);
  assert.equal(detailedReport.blocked.omitted, 5);
});

test('allowlist identifies rule vetoes and sighted destructive commands', () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'quartermaster-cli-test-'));
  const environment = permissionEnvironment(projectPath, [
    ...Array.from({ length: 3 }, () => 'git push origin main'),
    ...Array.from({ length: 3 }, () => 'git log --oneline; rm -f /tmp/quartermaster-log'),
  ]);

  const result = run('allowlist', projectPath, environment);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /permission:Bash:git push: vetoed as too broad a rule \(wildcard would cover destructive siblings\)/);
  assert.match(result.stdout, /permission:Bash:git log: sighted destructive command "git log --oneline; rm -f \/tmp\/quartermaster-log"/);
  const report = jsonReport(result);
  const push = report.blocked.top.find((entry) => entry.fingerprint === 'permission:Bash:git push');
  const log = report.blocked.top.find((entry) => entry.fingerprint === 'permission:Bash:git log');
  assert.equal(push.reason, 'vetoed as too broad a rule (wildcard would cover destructive siblings)');
  assert.equal(log.reason, 'sighted destructive command "git log --oneline; rm -f /tmp/quartermaster-log"');
});
