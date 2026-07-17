'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { makeCliRunner, makeMcpCaller } = require('./_helpers.js');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-telemetry-home-'));
const PROJ = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-telemetry-project-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;
process.env.CLAUDE_PROJECT_DIR = PROJ;
execFileSync('git', ['init', '--quiet'], { cwd: PROJ });
execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: PROJ });
execFileSync('git', ['config', 'user.name', 'Telemetry Test'], { cwd: PROJ });
fs.mkdirSync(path.join(PROJ, 'lib'));
fs.writeFileSync(path.join(PROJ, 'lib', 'tracked.js'), 'module.exports = 1;\n');
execFileSync('git', ['add', '.'], { cwd: PROJ });
execFileSync('git', ['commit', '--quiet', '-m', 'add tracked fixture'], { cwd: PROJ });

const mcp = require('../lib/mcp.js');
const BIN = path.join(__dirname, '..', 'bin', 'sidequest.js');
const { runCli, cliJson } = makeCliRunner(BIN, { SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: PROJ });
const { callTool } = makeMcpCaller(mcp);
let ref;

test('seed telemetry fixture', () => {
  const ticket = cliJson(['add', '-t', 'telemetry fixture', '--file', 'lib/tracked.js', '--complexity', '3', '--why', 'a routine tracked-file fixture for telemetry-read coverage', '--json']);
  ref = ticket.ticket.ref;
  assert.strictEqual(runCli(['claim', ref, '--by', 'telemetry-worker']).status, 0);
  assert.strictEqual(runCli(['comment', ref, '--by', 'telemetry-worker', '-m', 'a recent telemetry note']).status, 0);
});

test('CLI and MCP pulse return the compact liveness shape with git activity', () => {
  const pulse = cliJson(['pulse', ref]);
  assert.deepStrictEqual(Object.keys(pulse).sort(), ['claim', 'comments', 'dispatchExecutor', 'dispatchNonce', 'git', 'lastComment', 'project', 'projectName', 'ref', 'status', 'submission', 'title']);
  assert.deepStrictEqual(Object.keys(pulse.claim).sort(), ['ageMs', 'at', 'by']);
  assert.strictEqual(pulse.comments, 1);
  assert.deepStrictEqual(pulse.lastComment, { at: pulse.lastComment.at, by: 'telemetry-worker', kind: 'comment', body: 'a recent telemetry note' });
  assert.match(pulse.git.commit.hash, /^[0-9a-f]{40}$/);
  assert.strictEqual(pulse.git.dirty, false);
  const viaMcp = callTool('pulse', { ref });
  assert.strictEqual(viaMcp.ref, ref);
  assert.strictEqual(viaMcp.git.commit.hash, pulse.git.commit.hash);
});

test('changes returns an ordered compact delta and reusable serverTime', () => {
  const before = new Date(Date.now() - 1000).toISOString();
  assert.strictEqual(runCli(['comment', ref, '--by', 'telemetry-worker', '-m', 'a second telemetry note']).status, 0);
  const changes = cliJson(['changes', '--since', before]);
  assert.deepStrictEqual(Object.keys(changes).sort(), ['project', 'projectName', 'serverTime', 'since', 'tickets']);
  const changed = changes.tickets.find((ticket) => ticket.ref === ref);
  assert.deepStrictEqual(Object.keys(changed).sort(), ['claim', 'lastEventSource', 'lastEventType', 'ref', 'status', 'title', 'updatedAt']);
  assert.strictEqual(changed.lastEventType, 'comment');
  assert.strictEqual(changed.lastEventSource, 'cli');
  assert.ok(Date.parse(changes.serverTime) >= Date.parse(changed.updatedAt));
  const viaMcp = callTool('changes', { since: before });
  assert.ok(viaMcp.tickets.some((ticket) => ticket.ref === ref));
});

test('pulse git probe reports scoped working tree changes', () => {
  fs.writeFileSync(path.join(PROJ, 'lib', 'tracked.js'), 'module.exports = 2;\n');
  const pulse = cliJson(['pulse', ref]);
  assert.strictEqual(pulse.git.dirty, true);
});
