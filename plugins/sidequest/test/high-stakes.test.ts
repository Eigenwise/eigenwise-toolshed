import './_temp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const ROOT = path.resolve(__dirname, '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-high-stakes-home-'));
const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-high-stakes-project-'));
process.env.SIDEQUEST_HOME = home;
process.env.CLAUDE_PROJECT_DIR = projectPath;
process.env.SIDEQUEST_DISCOVERY_DIRS = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-high-stakes-catalog-'));

const store = require('../lib/store.js');
const agentsync = require('../lib/agentsync.js');
const mcp = require('../lib/mcp.js');
const cli = path.join(ROOT, 'bin', 'sidequest.js');

let rpcId = 0;
async function callTool(name: string, args: Record<string, unknown>) {
  const response = await mcp.handleRequest({
    jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args },
  });
  assert.equal(response.result.isError, undefined, response.result.content?.[0]?.text);
  return JSON.parse(response.result.content[0].text);
}

function runCli(args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, SIDEQUEST_HOME: home, CLAUDE_PROJECT_DIR: projectPath },
    windowsHide: true,
  });
}

function git(args: string[], cwd: string) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function submitIntegrationFixture(title: string, reviewed = false) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-high-stakes-integration-'));
  git(['init'], repo);
  git(['config', 'user.name', 'Sidequest Test'], repo);
  git(['config', 'user.email', 'sidequest-test@example.invalid'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n');
  git(['add', 'README.md'], repo);
  git(['commit', '-m', 'base'], repo);
  git(['branch', '-M', 'main'], repo);
  const slug = store.ensureProject(repo).slug;
  const ticket = store.createTicket(slug, { title, highStakes: true, files: ['feature.txt'] });
  if (reviewed) assert.equal(store.addComment(slug, ticket.ref, { by: 'reviewer', body: 'reviewed-by: reviewer', source: 'test' }).ok, true);
  fs.writeFileSync(path.join(repo, 'feature.txt'), 'fixture\n');
  git(['add', 'feature.txt'], repo);
  git(['commit', '-m', 'feature'], repo);
  const commit = git(['rev-parse', 'HEAD'], repo);
  const gitRef = `refs/sidequest/${ticket.ref}`;
  git(['update-ref', gitRef, commit], repo);
  const target = store.integrationTarget(slug);
  const range = require('../lib/commit-scope.js').submissionRange(repo, {
    commit,
    gitRef,
    upstream: target.upstream,
    integrationBranch: target.branch,
  });
  assert.equal(range.ok, true, JSON.stringify(range));
  assert.equal(store.claimTicket(slug, ticket.ref, 'worker', { direct: true }).ok, true);
  assert.equal(store.submitTicket(slug, ticket.ref, 'worker', { commit, gitRef, range, source: 'test' }).ok, true);
  return { slug, ticket };
}

test('highStakes round-trips through CLI and MCP without changing the coding.normal route', async () => {
  const slug = store.ensureProject(projectPath).slug;
  const normal = store.createTicket(slug, { title: 'normal route', category: 'coding.normal' });
  const flagged = store.createTicket(slug, { title: 'flagged route', category: 'coding.normal', highStakes: true });
  const normalRoute = store.getTicket(slug, normal.ref);
  const flaggedRoute = store.getTicket(slug, flagged.ref);
  assert.equal(flaggedRoute.highStakes, true);
  assert.equal(flaggedRoute.model, normalRoute.model);
  assert.equal(flaggedRoute.effort, normalRoute.effort);

  const added = await callTool('add', { project: slug, title: 'MCP high stakes', category: 'coding.normal', highStakes: true });
  assert.equal(store.getTicket(slug, added.ref).highStakes, true);
  await callTool('update', { project: slug, ref: added.ref, highStakes: false });
  assert.equal(store.getTicket(slug, added.ref).highStakes, false);

  const cliAdded = runCli(['add', '--title', 'CLI high stakes', '--category', 'coding.normal', '--high-stakes', '--json']);
  assert.equal(cliAdded.status, 0, cliAdded.stderr);
  const cliRef = JSON.parse(cliAdded.stdout).ticket.ref;
  assert.equal(JSON.parse(runCli(['update', cliRef, '--high-stakes=false', '--json']).stdout).ticket.highStakes, false);
  assert.equal(JSON.parse(runCli(['update', cliRef, '--high-stakes', '--json']).stdout).ticket.highStakes, true);
});

test('only high-stakes briefings require expanded verification', () => {
  const basic = agentsync.renderTicketBriefing({ ref: 'SQ-basic', title: 'Basic', category: {}, model: 'sonnet', effort: 'medium' }, 'basic-token');
  const high = agentsync.renderTicketBriefing({ ref: 'SQ-high', title: 'High', category: {}, model: 'sonnet', effort: 'medium', highStakes: true }, 'high-token');
  assert.doesNotMatch(basic, /High-stakes verification/);
  assert.match(high, /High-stakes verification/);
  assert.match(high, /EVERY consumer/);
  assert.match(high, /review-audit pass is mandatory before integration/);
});

test('high-stakes integration warns until a review is recorded', async () => {
  const unreviewed = submitIntegrationFixture('Unreviewed');
  const warned = await callTool('groomClose', {
    project: unreviewed.slug, ref: unreviewed.ticket.ref, by: 'integrator', reason: 'Integrated test fixture.', integration: true,
  });
  assert.equal(warned.ok, true);
  assert.equal(warned.advisory, 'high-stakes ticket integrated without a recorded review pass');

  const reviewed = submitIntegrationFixture('Reviewed', true);
  const closed = store.completeTicketAsControlPlane(reviewed.slug, reviewed.ticket.ref, {
    purpose: 'integration', by: 'integrator', reason: 'Integrated test fixture.',
  });
  assert.equal(closed.ok, true);
  assert.equal(closed.advisory, undefined);
});
