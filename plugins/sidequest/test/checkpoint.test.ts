'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-checkpoint-test-'));
const PROJECT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-checkpoint-project-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;
process.env.CLAUDE_PROJECT_DIR = PROJECT_DIR;
process.env.SIDEQUEST_CLAIM_TTL_MIN = '60';

const store = require('../lib/store.js');
const mcp = require('../lib/mcp.js');
const { makeCliRunner } = require('./_helpers.js');

const { slug } = store.ensureProject(PROJECT_DIR);
const exploration = store.getCategory('codebase-exploration');
store.setCategory(Object.assign({}, exploration, { route: { model: 'sonnet', effort: 'medium' }, fallback: null }));
const BIN = path.join(__dirname, '..', 'bin', 'sidequest.js');
const { cliJson } = makeCliRunner(BIN, { SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: PROJECT_DIR }, { cwd: PROJECT_DIR });
const COMMIT = 'abc1234def5678abc1234def5678abc1234def56';

function addRouted(title?: any) {
  return store.createTicket(slug, {
    title,
    description: 'Where: checkpoint lifecycle fixture. Contract: keep the routed executor live for review. Verify: inspect persisted board state.',
    category: 'codebase-exploration',
    files: ['lib/fixture.js'],
    source: 'cli',
  });
}

function addDirect(title?: any) {
  return store.createTicket(slug, {
    title,
    complexity: 2,
    complexityWhy: 'single checkpoint lifecycle fixture with no implementation work',
    labels: ['direct-ok'],
    files: ['lib/fixture.js'],
    source: 'cli',
  });
}

function claimRouted(ticket?: any, by?: any) {
  const prepared = store.prepareDispatch(slug, ticket.ref, { sharedTree: false });
  const claimed = store.claimTicket(slug, ticket.ref, by, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    source: 'mcp',
  });
  assert.strictEqual(claimed.ok, true);
  return prepared;
}

function claimDirect(ticket?: any, by?: any) {
  const claimed = store.claimTicket(slug, ticket.ref, by, {
    direct: true,
    reason: 'The checkpoint lifecycle fixture needs a local direct claim.',
    source: 'cli',
  });
  assert.strictEqual(claimed.ok, true);
}

let requestId = 0;
async function callTool(name?: any, args?: any) {
  const response = await mcp.handleRequest({
    jsonrpc: '2.0',
    id: ++requestId,
    method: 'tools/call',
    params: { name, arguments: args || {} },
  });
  assert.ok(response && response.result);
  assert.ok(!response.result.isError, response.result.content && response.result.content[0] && response.result.content[0].text);
  return JSON.parse(response.result.content[0].text);
}

test('checkpoint creates and replaces a live review candidate without terminalizing its dispatch', () => {
  const ticket = addRouted('live checkpoint create');
  const prepared = claimRouted(ticket, 'worker-a');
  const first = store.checkpointTicket(slug, ticket.ref, 'worker-a', {
    commit: COMMIT.toUpperCase(),
    verify: 'npm test: 12 passed, 0 failed',
    ttlMinutes: 15,
    source: 'mcp',
  });

  assert.strictEqual(first.ok, true);
  assert.match(first.checkpoint.id, /^cp_[0-9a-f]{16}$/);
  assert.strictEqual(first.checkpoint.state, 'active');
  assert.strictEqual(first.checkpoint.commit, COMMIT);
  assert.match(first.comment.body, new RegExp(`Live review checkpoint ${first.checkpoint.id}`));

  const afterFirst = store.getTicket(slug, ticket.ref);
  assert.strictEqual(afterFirst.claim.by, 'worker-a');
  assert.strictEqual(afterFirst.dispatchNonce, prepared.token);
  assert.strictEqual(afterFirst.dispatch.terminalAt, null);
  assert.strictEqual(afterFirst.dispatch.outcome, 'claimed');
  assert.strictEqual(store.pulsePayload(slug, ticket.ref).checkpoint.id, first.checkpoint.id);

  const second = store.checkpointTicket(slug, ticket.ref, 'worker-a', {
    worktree: PROJECT_DIR,
    verify: 'npm test after corrections: 13 passed, 0 failed',
    source: 'mcp',
  });
  assert.strictEqual(second.ok, true);
  assert.notStrictEqual(second.checkpoint.id, first.checkpoint.id);
  assert.strictEqual(second.checkpoint.state, 'active');
  assert.strictEqual(store.getTicket(slug, ticket.ref).dispatch.terminalAt, null);

  const changes = store.changesPayload(slug, new Date(Date.parse(second.checkpoint.at) - 1).toISOString());
  const changed = changes.tickets.find((entry?: any) => entry.ref === ticket.ref);
  assert.strictEqual(changed.checkpoint.id, second.checkpoint.id);
  assert.strictEqual(changed.checkpoint.state, 'active');
});

test('checkpoint TTL is bounded and expiry is surfaced as a derived change', () => {
  const ticket = addDirect('checkpoint expiry');
  claimDirect(ticket, 'expiry-worker');
  assert.throws(() => store.checkpointTicket(slug, ticket.ref, 'expiry-worker', {
    commit: COMMIT,
    verify: 'passed',
    ttlMinutes: store.MAX_CHECKPOINT_TTL_MIN + 1,
  }), /checkpoint TTL/);

  const checkpointAt = Date.now() - 2 * 60 * 1000;
  const created = store.checkpointTicket(slug, ticket.ref, 'expiry-worker', {
    commit: COMMIT,
    verify: 'node --test: 1 passed, 0 failed',
    ttlMinutes: 1,
    now: checkpointAt,
  });
  assert.strictEqual(store.checkpointProjection(created.ticket, checkpointAt + 30_000).state, 'active');
  assert.strictEqual(store.checkpointProjection(store.getTicket(slug, ticket.ref)).state, 'expired');

  const changes = store.changesPayload(slug, new Date(checkpointAt + 30_000).toISOString());
  const expired = changes.tickets.find((entry?: any) => entry.ref === ticket.ref);
  assert.ok(expired);
  assert.strictEqual(expired.checkpoint.state, 'expired');
  assert.strictEqual(expired.checkpoint.expiresAt, created.checkpoint.expiresAt);
  assert.ok(Date.parse(expired.updatedAt) < checkpointAt + 30_000);
});

test('release and redispatch preserve checkpoint evidence for recovery', () => {
  const ticket = addRouted('checkpoint recovery');
  claimRouted(ticket, 'worker-before-crash');
  const created = store.checkpointTicket(slug, ticket.ref, 'worker-before-crash', {
    worktree: PROJECT_DIR,
    verify: 'npm run test:full: passed',
    ttlMinutes: 30,
  });

  const released = store.releaseTicket(slug, ticket.ref, 'worker-before-crash', { status: 'todo', source: 'mcp' });
  assert.strictEqual(released.ok, true);
  let recoveredTicket = store.getTicket(slug, ticket.ref);
  assert.strictEqual(recoveredTicket.checkpoint.id, created.checkpoint.id);
  assert.strictEqual(store.checkpointProjection(recoveredTicket).state, 'recoverable');

  const prepared = store.prepareDispatch(slug, ticket.ref, { sharedTree: false });
  const claimed = store.claimTicket(slug, ticket.ref, 'replacement-worker', {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    source: 'mcp',
  });
  assert.strictEqual(claimed.ok, true);
  recoveredTicket = store.getTicket(slug, ticket.ref);
  assert.strictEqual(store.checkpointProjection(recoveredTicket).state, 'resumed');

  const briefing = store.readDispatchBriefing(slug, ticket.ref, prepared.token);
  assert.strictEqual(briefing.ok, true);
  assert.strictEqual(briefing.ticket.checkpoint.id, created.checkpoint.id);
  assert.ok(briefing.ticket.comments.some((comment?: any) => comment.body.includes(`Live review checkpoint ${created.checkpoint.id}`)));
});

test('submit remains terminal after a live review checkpoint', () => {
  const ticket = addRouted('checkpoint submit terminal');
  claimRouted(ticket, 'submit-worker');
  const checkpoint = store.checkpointTicket(slug, ticket.ref, 'submit-worker', {
    commit: COMMIT,
    verify: 'npm run test:full: passed',
  });
  assert.strictEqual(checkpoint.ok, true);
  assert.strictEqual(store.getTicket(slug, ticket.ref).dispatch.terminalAt, null);

  const submitted = store.submitTicket(slug, ticket.ref, 'submit-worker', { commit: COMMIT, verify: 'npm run test:full' });
  assert.strictEqual(submitted.ok, true);
  const after = store.getTicket(slug, ticket.ref);
  assert.strictEqual(after.claim, null);
  assert.strictEqual(after.dispatchNonce, null);
  assert.ok(after.dispatch.terminalAt);
  assert.strictEqual(after.dispatch.outcome, 'submitted');
  assert.strictEqual(store.checkpointProjection(after).state, 'submitted');
});

test('CLI and MCP expose the checkpoint operation and compact pulse state', async () => {
  const cliTicket = addDirect('CLI checkpoint');
  claimDirect(cliTicket, 'cli-worker');
  const cli = cliJson([
    'checkpoint', cliTicket.ref,
    '--project', PROJECT_DIR,
    '--by', 'cli-worker',
    '--worktree', PROJECT_DIR,
    '--verify', 'node --test: 2 passed, 0 failed',
    '--ttl-minutes', '10',
    '--json',
  ]);
  assert.strictEqual(cli.ok, true);
  assert.strictEqual(cli.checkpoint.state, 'active');
  assert.strictEqual(cli.checkpoint.ttlMinutes, 10);

  const mcpTicket = addDirect('MCP checkpoint');
  claimDirect(mcpTicket, 'mcp-worker');
  const result = await callTool('checkpoint', {
    ref: mcpTicket.ref,
    project: PROJECT_DIR,
    by: 'mcp-worker',
    commit: COMMIT,
    verify: 'node --test: 3 passed, 0 failed',
    ttlMinutes: 20,
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.checkpoint.state, 'active');

  const pulse = await callTool('pulse', { ref: mcpTicket.ref, project: PROJECT_DIR });
  assert.strictEqual(pulse.checkpoint.id, result.checkpoint.id);
  assert.strictEqual(pulse.checkpoint.state, 'active');
});
