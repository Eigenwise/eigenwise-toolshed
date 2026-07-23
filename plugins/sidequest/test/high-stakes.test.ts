import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

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
  const slug = store.ensureProject(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-high-stakes-integration-'))).slug;
  const unreviewed = store.createTicket(slug, { title: 'Unreviewed', highStakes: true });
  assert.equal(store.claimTicket(slug, unreviewed.ref, 'worker', { direct: true }).ok, true);
  assert.equal(store.submitTicket(slug, unreviewed.ref, 'worker', { commit: 'abc1234', source: 'test' }).ok, true);
  const warned = await callTool('groomClose', {
    project: slug, ref: unreviewed.ref, by: 'integrator', reason: 'Integrated test fixture.', integration: true,
  });
  assert.equal(warned.ok, true);
  assert.equal(warned.advisory, 'high-stakes ticket integrated without a recorded review pass');

  const reviewed = store.createTicket(slug, { title: 'Reviewed', highStakes: true });
  assert.equal(store.addComment(slug, reviewed.ref, { by: 'reviewer', body: 'reviewed-by: reviewer', source: 'test' }).ok, true);
  assert.equal(store.claimTicket(slug, reviewed.ref, 'worker', { direct: true }).ok, true);
  assert.equal(store.submitTicket(slug, reviewed.ref, 'worker', { commit: 'def5678', source: 'test' }).ok, true);
  const closed = store.completeTicketAsControlPlane(slug, reviewed.ref, {
    purpose: 'integration', by: 'integrator', reason: 'Integrated test fixture.',
  });
  assert.equal(closed.ok, true);
  assert.equal(closed.advisory, undefined);
});
