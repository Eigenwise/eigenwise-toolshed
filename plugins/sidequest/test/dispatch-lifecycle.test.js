'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-dispatch-lifecycle-home-'));
const PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-dispatch-lifecycle-project-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;
process.env.CLAUDE_PROJECT_DIR = PROJECT;
execFileSync('git', ['init', '--quiet'], { cwd: PROJECT });
execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: PROJECT });
execFileSync('git', ['config', 'user.name', 'Dispatch Lifecycle Test'], { cwd: PROJECT });
fs.writeFileSync(path.join(PROJECT, 'tracked.js'), 'module.exports = 1;\n');
execFileSync('git', ['add', 'tracked.js'], { cwd: PROJECT });
execFileSync('git', ['commit', '--quiet', '-m', 'seed fixture'], { cwd: PROJECT });

const store = require('../lib/store.js');
const FORCE_EXEC_BYPASS = path.join(__dirname, '..', 'hooks', 'force-exec-bypass.js');
const slug = store.ensureProject(PROJECT).slug;

store.setCategory({
  id: 'dispatch.lifecycle',
  name: 'Dispatch lifecycle',
  route: { model: 'sonnet', effort: 'high' },
  fallback: null,
  enabled: true,
});

function createFixture(title) {
  return store.createTicket(slug, {
    title,
    category: 'dispatch.lifecycle',
    files: ['tracked.js'],
    source: 'test',
  });
}

function runForceBypass(payload) {
  const output = execFileSync(process.execPath, [FORCE_EXEC_BYPASS], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: PROJECT },
  });
  return output.trim() ? JSON.parse(output) : null;
}

test('batch launch records every prepared ticket and binds the shared native agent', () => {
  const first = createFixture('first batch lifecycle fixture');
  const second = createFixture('second batch lifecycle fixture');
  const sessionId = `batch-${Date.now()}`;
  const firstPrepared = store.prepareDispatch(slug, first.ref, { sessionId });
  const secondPrepared = store.prepareDispatch(slug, second.ref, { sessionId });
  const executor = firstPrepared.ticket.dispatchExecutor;
  assert.equal(secondPrepared.ticket.dispatchExecutor, executor);

  const prompt = [
    `Ref: ${first.ref}`,
    `Claim this ticket with \`--token ${firstPrepared.token}\`.`,
    `Ref: ${second.ref}`,
    `Claim this ticket with \`--token ${secondPrepared.token}\`.`,
    `--project "${PROJECT}"`,
  ].join('\n');
  runForceBypass({
    session_id: sessionId,
    tool_name: 'Agent',
    tool_input: {
      subagent_type: executor,
      name: 'batch-lifecycle-worker',
      prompt,
    },
  });

  for (const ref of [first.ref, second.ref]) {
    const ticket = store.getTicket(slug, ref);
    assert.equal(ticket.dispatch.outcome, 'launched');
    assert.equal(ticket.lastEventType, 'dispatch');
  }

  const bound = store.bindDispatchAgent(sessionId, executor, 'native-batch-agent', 'batch-lifecycle-worker');
  assert.equal(bound.ok, true);
  assert.equal(bound.tickets.length, 2);
  for (const ref of [first.ref, second.ref]) {
    const pulse = store.pulsePayload(slug, ref);
    assert.equal(pulse.dispatch.state, 'bound');
    assert.ok(pulse.dispatch.boundAt);
    assert.equal(pulse.working, false);
  }
});

test('pulse reports derived activity and dispatch changes without leaking a nonce', () => {
  const ticket = createFixture('complete lifecycle fixture');
  const sessionId = `lifecycle-${Date.now()}`;
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
  const executor = prepared.ticket.dispatchExecutor;
  const since = new Date(Date.now() - 1000).toISOString();

  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    sessionId,
    token: prepared.token,
    executor,
    agentName: 'complete-lifecycle-worker',
  }).ok, true);
  assert.equal(store.bindDispatchAgent(sessionId, executor, 'native-complete-agent', 'complete-lifecycle-worker').ok, true);
  let pulse = store.pulsePayload(slug, ticket.ref);
  assert.equal(pulse.dispatch.state, 'bound');
  assert.equal(Object.hasOwn(pulse, 'dispatchNonce'), false);
  assert.equal(JSON.stringify(pulse).includes(prepared.token), false);
  assert.equal(pulse.dispatch.tokenPrefix, prepared.token.slice(0, 12));

  assert.equal(store.claimTicket(slug, ticket.ref, 'lifecycle-worker', {
    sessionId,
    token: prepared.token,
    executor,
  }).ok, true);
  pulse = store.pulsePayload(slug, ticket.ref);
  assert.equal(pulse.dispatch.state, 'claimed');
  assert.equal(pulse.working, true);
  assert.equal(pulse.lastActivityAt, pulse.claim.at);
  assert.equal(store.changesPayload(slug, since).tickets.find((entry) => entry.ref === ticket.ref).lastEventType, 'dispatch');

  store.addComment(slug, ticket.ref, {
    by: 'lifecycle-worker',
    body: 'Verified the scoped lifecycle fixture.',
    source: 'test',
  });
  pulse = store.pulsePayload(slug, ticket.ref);
  assert.equal(pulse.lastActivityAt, store.getTicket(slug, ticket.ref).comments.at(-1).at);

  assert.equal(store.completeTicket(slug, ticket.ref, 'lifecycle-worker', {
    model: 'sonnet',
    effort: 'high',
    source: 'test',
  }).ok, true);
  pulse = store.pulsePayload(slug, ticket.ref);
  assert.equal(pulse.dispatch.state, 'done');
  assert.equal(pulse.dispatch.outcome, 'done');
  assert.equal(store.getTicket(slug, ticket.ref).lastEventType, 'dispatch');
});

test('release and submission clear retain structured rework attempts', () => {
  const ticket = createFixture('structured rework fixture');
  const firstSession = `rework-first-${Date.now()}`;
  const first = store.prepareDispatch(slug, ticket.ref, { sessionId: firstSession });
  const executor = first.ticket.dispatchExecutor;
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    sessionId: firstSession,
    token: first.token,
    executor,
    agentName: 'rework-first-worker',
  }).ok, true);
  assert.equal(store.bindDispatchAgent(firstSession, executor, 'rework-agent-1', 'rework-first-worker').ok, true);
  assert.equal(store.claimTicket(slug, ticket.ref, 'rework-first-worker', {
    sessionId: firstSession,
    token: first.token,
    executor,
  }).ok, true);
  assert.equal(store.releaseTicket(slug, ticket.ref, 'rework-first-worker', {
    status: 'todo',
    source: 'test',
  }).ok, true);

  let after = store.getTicket(slug, ticket.ref);
  assert.equal(after.reworkEvents.length, 1);
  assert.equal(after.reworkEvents[0].kind, 'released_to_todo');
  assert.equal(after.reworkEvents[0].attempt.agentId, 'rework-agent-1');
  assert.deepEqual(after.reworkEvents[0].attempt.route, { model: 'sonnet', effort: 'high' });
  assert.equal(after.reworkEvents[0].attempt.outcome, 'released');
  assert.equal(store.releaseTicket(slug, ticket.ref, 'rework-first-worker', {
    status: 'todo',
    source: 'test',
  }).ok, true);
  assert.equal(store.getTicket(slug, ticket.ref).reworkEvents.length, 1);

  const secondSession = `rework-second-${Date.now()}`;
  const second = store.prepareDispatch(slug, ticket.ref, { sessionId: secondSession });
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    sessionId: secondSession,
    token: second.token,
    executor,
    agentName: 'rework-second-worker',
  }).ok, true);
  assert.equal(store.bindDispatchAgent(secondSession, executor, 'rework-agent-2', 'rework-second-worker').ok, true);
  assert.equal(store.claimTicket(slug, ticket.ref, 'rework-second-worker', {
    sessionId: secondSession,
    token: second.token,
    executor,
  }).ok, true);
  assert.equal(store.submitTicket(slug, ticket.ref, 'rework-second-worker', {
    commit: 'abc1234def5678',
    source: 'test',
  }).ok, true);
  assert.equal(store.clearSubmission(slug, ticket.ref, { status: 'todo', source: 'test' }).ok, true);

  after = store.getTicket(slug, ticket.ref);
  assert.equal(after.reworkEvents.length, 2);
  assert.equal(after.reworkEvents[1].kind, 'submission_cleared');
  assert.equal(after.reworkEvents[1].attempt.agentId, 'rework-agent-2');
  assert.equal(after.reworkEvents[1].attempt.outcome, 'submitted');
  assert.equal(Object.hasOwn(after.reworkEvents[1], 'submission'), false);
});

test('prepared dispatches expire on the configured TTL with an audit comment', () => {
  const ticket = createFixture('prepared expiry fixture');
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: 'prepared-expiry' });
  const expiresAt = Date.parse(prepared.ticket.dispatch.preparedAt) + store.preparedDispatchTtlMs() + 1;

  const swept = store.sweepStaleDispatches({ project: slug, now: expiresAt, source: 'test' });
  assert.deepEqual(swept.expired.map((entry) => entry.ref), [ticket.ref]);
  const after = store.getTicket(slug, ticket.ref);
  assert.equal(after.dispatch.outcome, 'expired');
  assert.equal(after.dispatchNonce, null);
  assert.equal(after.dispatchExecutor, null);
  assert.match(after.comments.at(-1).body, /Auto-expired prepared dispatch/);
});

test('reconciliation fails unbound launches and preserves bound agents', () => {
  const unboundTicket = createFixture('unbound reload fixture');
  const boundTicket = createFixture('bound reload fixture');
  const sessionId = `restart-${Date.now()}`;
  const unbound = store.prepareDispatch(slug, unboundTicket.ref, { sessionId });
  const bound = store.prepareDispatch(slug, boundTicket.ref, { sessionId });
  const executor = unbound.ticket.dispatchExecutor;

  for (const prepared of [unbound, bound]) {
    assert.equal(store.recordDispatchLaunch(slug, prepared.ticket.ref, {
      sessionId,
      token: prepared.token,
      executor,
      agentName: prepared.ticket.ref,
    }).ok, true);
  }
  assert.equal(store.bindDispatchAgent(sessionId, executor, 'bound-agent', boundTicket.ref).ok, true);

  const reconciled = store.reconcileLaunchedDispatches(sessionId, { source: 'session-start' });
  assert.deepEqual(reconciled.reconciled, [unboundTicket.ref]);
  assert.equal(store.getTicket(slug, unboundTicket.ref).dispatch.outcome, 'failed');
  const survived = store.getTicket(slug, boundTicket.ref);
  assert.equal(survived.dispatch.boundAt != null, true);
  assert.equal(survived.dispatch.outcome, 'launched');
  assert.ok(survived.dispatchNonce);
});

test('re-dispatch supersedes stale tokens and terminal cleanup removes active credentials', () => {
  const ticket = createFixture('superseded dispatch fixture');
  const first = store.prepareDispatch(slug, ticket.ref, { sessionId: 'superseded' });
  const second = store.prepareDispatch(slug, ticket.ref, { sessionId: 'superseded' });
  assert.notEqual(first.token, second.token);
  assert.equal(store.claimTicket(slug, ticket.ref, 'stale-worker', {
    token: first.token,
    executor: first.ticket.dispatchExecutor,
  }).reason, 'token');
  const staleClaim = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'sidequest.js'), 'claim', ticket.ref,
    '--project', PROJECT, '--by', 'stale-worker', '--token', first.token, '--executor', first.ticket.dispatchExecutor], {
    encoding: 'utf8',
    env: { ...process.env, SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: PROJECT },
  });
  assert.equal(staleClaim.status, 1);
  assert.match(staleClaim.stdout, /dispatch was superseded by a newer preparation/);
  assert.equal(store.claimTicket(slug, ticket.ref, 'current-worker', {
    token: second.token,
    executor: second.ticket.dispatchExecutor,
  }).ok, true);
  assert.equal(store.completeTicket(slug, ticket.ref, 'current-worker', {
    model: 'sonnet',
    effort: 'high',
    source: 'test',
  }).ok, true);
  const after = store.getTicket(slug, ticket.ref);
  assert.equal(after.dispatchNonce, null);
  assert.equal(after.dispatchExecutor, null);
  assert.equal(after.dispatch.terminalAt != null, true);
  assert.equal(after.dispatch.supersededTokens, undefined);
});
