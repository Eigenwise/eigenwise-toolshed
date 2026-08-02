import './_temp-cleanup.js';
import './_sidequest-install-fixture.js';
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-dispatch-lifecycle-home-'));
const PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-dispatch-lifecycle-project-'));
const DISCOVERY = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-dispatch-lifecycle-catalog-'));
fs.mkdirSync(path.join(DISCOVERY, 'model-gateway'), { recursive: true });
fs.writeFileSync(path.join(DISCOVERY, 'model-gateway', 'catalog.json'), JSON.stringify({
  schemaVersion: 3,
  source: 'model-gateway',
  codexReadiness: { ready: true, state: 'ready', message: 'Codex readiness confirms the local gateway is ready.' },
  models: [
    { slug: 'codex-gpt-5-6-sol', id: 'claude-gpt-5.6-sol[1m]', label: 'GPT-5.6 Sol' },
    { slug: 'codex-gpt-5-6-terra', id: 'claude-gpt-5.6-terra[1m]', label: 'GPT-5.6 Terra' },
  ],
}));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;
process.env.SIDEQUEST_DISCOVERY_DIRS = DISCOVERY;
process.env.CLAUDE_PROJECT_DIR = PROJECT;
execFileSync('git', ['init', '--quiet'], { cwd: PROJECT });
execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: PROJECT });
execFileSync('git', ['config', 'user.name', 'Dispatch Lifecycle Test'], { cwd: PROJECT });
fs.writeFileSync(path.join(PROJECT, 'tracked.js'), 'module.exports = 1;\n');
execFileSync('git', ['add', 'tracked.js'], { cwd: PROJECT });
execFileSync('git', ['commit', '--quiet', '-m', 'seed fixture'], { cwd: PROJECT });

const store = require('../lib/store.js');
const FORCE_EXEC_BYPASS = path.join(__dirname, '..', 'hooks', 'force-exec-bypass.js');
const SUBAGENT_START = path.join(__dirname, '..', 'hooks', 'subagent-start.js');
const SUBAGENT_STOP = path.join(__dirname, '..', 'hooks', 'subagent-stop.js');
const slug = store.ensureProject(PROJECT).slug;

store.setCategory({
  id: 'dispatch.lifecycle',
  name: 'Dispatch lifecycle',
  route: { model: 'sonnet', effort: 'high' },
  fallback: null,
  enabled: true,
});

for (const id of ['codebase-exploration', 'research', 'review-audit', 'spike-investigation', 'visual-review']) {
  store.setCategory({ id, name: id, route: { model: 'sonnet', effort: 'high' }, fallback: null, readonly: true, enabled: true });
}

function createFixture(title?: any, category = 'dispatch.lifecycle') {
  return store.createTicket(slug, {
    title,
    category,
    files: ['tracked.js'],
    source: 'test',
  });
}

function runForceBypass(payload?: any) {
  const output = execFileSync(process.execPath, [FORCE_EXEC_BYPASS], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: PROJECT },
  });
  return output.trim() ? JSON.parse(output) : null;
}

function runLifecycleHook(hook?: any, payload?: any) {
  const output = execFileSync(process.execPath, [hook], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: PROJECT },
  });
  return output.trim() ? JSON.parse(output) : null;
}

function dispatchBindingCounts(refs: any[]) {
  const launched = refs.map((ref) => store.getTicket(slug, ref).dispatch).filter((dispatch) => dispatch.launchedAt);
  return {
    launched: launched.length,
    unbound: launched.filter((dispatch) => !dispatch.boundAt).length,
    noAgentId: launched.filter((dispatch) => !dispatch.agentId).length,
  };
}

test('read-only category classes dispatch through restricted stable executors', () => {
  for (const category of ['codebase-exploration', 'research', 'review-audit', 'spike-investigation', 'visual-review']) {
    const ticket = createFixture(`${category} fixture`, category);
    const prepared = store.prepareDispatch(slug, ticket.ref);
    assert.equal(prepared.ticket.dispatch.readonly, true);
    assert.equal(prepared.ticket.dispatchExecutor, 'sidequest-exec-readonly-high');
    assert.equal(store.claimTicket(slug, ticket.ref, 'read-only-test-worker', {
      token: prepared.token,
      executor: prepared.ticket.dispatchExecutor,
      source: 'test',
    }).ok, true);
    assert.equal(store.releaseTicket(slug, ticket.ref, 'read-only-test-worker', { source: 'test' }).ok, true);
  }

  const override = store.createTicket(slug, {
    title: 'mutable spike fixture',
    category: 'spike-investigation',
    readonly: false,
    files: ['tracked.js'],
    source: 'test',
  });
  assert.equal(store.getTicket(slug, override.ref).readonlyOverride, false);
  assert.equal(store.listPayload(slug, { brief: true }).tickets.find((ticket?: any) => ticket.ref === override.ref).readonlyOverride, false);
  const overridePrepared = store.prepareDispatch(slug, override.ref);
  assert.equal(overridePrepared.ticket.dispatchExecutor, 'sidequest-exec-high');
  assert.match(store.dispatchWarnings(overridePrepared.ticket).join('\n'), /readonly override active/);
  assert.equal(store.claimTicket(slug, override.ref, 'override-test-worker', {
    token: overridePrepared.token,
    executor: overridePrepared.ticket.dispatchExecutor,
    source: 'test',
  }).ok, true);
  assert.equal(store.releaseTicket(slug, override.ref, 'override-test-worker', { source: 'test' }).ok, true);

  const readOnlyOverride = store.createTicket(slug, {
    title: 'read-only coding fixture',
    category: 'coding.normal',
    readonly: true,
    source: 'test',
  });
  assert.equal(store.getTicket(slug, readOnlyOverride.ref).readonlyOverride, true);
  const readOnlyOverridePrepared = store.prepareDispatch(slug, readOnlyOverride.ref);
  assert.equal(readOnlyOverridePrepared.ticket.dispatch.readonly, true);
  assert.match(readOnlyOverridePrepared.ticket.dispatchExecutor, /readonly/);
  assert.match(store.dispatchWarnings(readOnlyOverridePrepared.ticket).join('\n'), /readonly override active/);
  assert.equal(store.claimTicket(slug, readOnlyOverride.ref, 'read-only-override-worker', {
    token: readOnlyOverridePrepared.token,
    executor: readOnlyOverridePrepared.ticket.dispatchExecutor,
    source: 'test',
  }).ok, true);
  assert.equal(store.releaseTicket(slug, readOnlyOverride.ref, 'read-only-override-worker', { source: 'test' }).ok, true);

  const contradiction = store.createTicket(slug, {
    title: 'contradictory spike fixture',
    category: 'spike-investigation',
    files: ['tracked.js'],
    source: 'test',
  });
  assert.match(store.ticketPlanningWarnings(store.getTicket(slug, contradiction.ref)).join('\n'), /Readonly category contradicts declared write intent/);
  const contradictionPrepared = store.prepareDispatch(slug, contradiction.ref);
  assert.match(store.dispatchWarnings(contradictionPrepared.ticket).join('\n'), /Readonly category contradicts declared write intent/);
  assert.equal(store.claimTicket(slug, contradiction.ref, 'contradiction-worker', {
    token: contradictionPrepared.token,
    executor: contradictionPrepared.ticket.dispatchExecutor,
    source: 'test',
  }).ok, true);
  assert.equal(store.releaseTicket(slug, contradiction.ref, 'contradiction-worker', { source: 'test' }).ok, true);

  const updatedOverride = createFixture('updated mutable spike fixture', 'spike-investigation');
  assert.equal(store.updateTicket(slug, updatedOverride.ref, { readonly: false, source: 'test' }).readonlyOverride, false);
  const updatedPrepared = store.prepareDispatch(slug, updatedOverride.ref);
  assert.equal(updatedPrepared.ticket.dispatchExecutor, 'sidequest-exec-high');
  assert.equal(store.claimTicket(slug, updatedOverride.ref, 'updated-override-test-worker', {
    token: updatedPrepared.token,
    executor: updatedPrepared.ticket.dispatchExecutor,
    source: 'test',
  }).ok, true);
  assert.equal(store.releaseTicket(slug, updatedOverride.ref, 'updated-override-test-worker', { source: 'test' }).ok, true);
});

test('dispatch warnings flag WebSearch only for constrained Claude routes', () => {
  const warning = /WebSearch is unavailable on this Claude xhigh\/max route.*research-category ticket/;
  for (const [model, effort] of [['opus', 'xhigh'], ['sonnet', 'max'], ['fable', 'xhigh']]) {
    assert.match(store.dispatchWarnings({ model, effort }).join('\n'), warning, `${model}/${effort}`);
  }
  for (const [model, effort] of [['codex-gpt-5-6-terra', 'xhigh'], ['opus', 'high']]) {
    assert.doesNotMatch(store.dispatchWarnings({ model, effort }).join('\n'), warning, `${model}/${effort}`);
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
  assert.equal(store.changesPayload(slug, since).tickets.find((entry?: any) => entry.ref === ticket.ref).lastEventType, 'dispatch');

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
  }).ok, false);
  assert.equal(store.releaseTicket(slug, ticket.ref, 'lifecycle-worker', { status: 'todo', source: 'test' }).ok, true);
  assert.equal(store.completeTicketAsControlPlane(slug, ticket.ref, {
    purpose: 'grooming',
    by: 'board-groomer',
    reason: 'Verified the lifecycle fixture as complete.',
  }).ok, true);
  pulse = store.pulsePayload(slug, ticket.ref);
  assert.equal(pulse.dispatch.state, 'done');
  assert.equal(pulse.dispatch.outcome, 'done');
  assert.equal(store.getTicket(slug, ticket.ref).lastEventType, 'dispatch');
});

test('oracle releases retain the round marker in pulse, changes, and brief list projections', () => {
  const ticket = createFixture('oracle projection fixture');
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: `oracle-projection-${Date.now()}` });
  assert.equal(store.claimTicket(slug, ticket.ref, 'oracle-projection-worker', {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);

  assert.equal(store.releaseTicket(slug, ticket.ref, 'oracle-projection-worker', {
    status: 'doing',
    oracle: 'Rank the candidates best to worst.',
    candidate: 'abc1234',
    deliverable: 'artifacts/round-1.wav',
    source: 'test',
  }).ok, true);

  const stored = store.getTicket(slug, ticket.ref);
  assert.equal(stored.oracle.round, 1);
  const expected = `awaiting oracle since ${stored.oracle.at}, round 1, candidate abc1234, ask: Rank the candidates best to worst.`;
  assert.equal(store.pulsePayload(slug, ticket.ref).oracle.summary, expected);
  assert.equal(store.changesPayload(slug, new Date(0).toISOString()).tickets.find((entry?: any) => entry.ref === ticket.ref).oracle.summary, expected);
  assert.equal(store.listPayload(slug, { brief: true, all: true }).tickets.find((entry?: any) => entry.ref === ticket.ref).oracle.summary, expected);
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
  }).ok, false);
  assert.equal(store.releaseTicket(slug, ticket.ref, 'current-worker', { status: 'todo', source: 'test' }).ok, true);
  assert.equal(store.completeTicketAsControlPlane(slug, ticket.ref, {
    purpose: 'grooming',
    by: 'board-groomer',
    reason: 'Verified the superseded-token lifecycle fixture.',
  }).ok, true);
  const after = store.getTicket(slug, ticket.ref);
  assert.equal(after.dispatchNonce, null);
  assert.equal(after.dispatchExecutor, null);
  assert.equal(after.dispatch.terminalAt != null, true);
  assert.equal(after.dispatch.supersededTokens, undefined);
});

const TEAMMATE_IDLE = path.join(__dirname, '..', 'hooks', 'teammate-idle.js');

// What the harness actually sends: base hook input plus `teammate_name` and
// `team_name`, with no agent id, the idle teammate's own session, and an agent
// type that is not the dispatch executor.
function runTeammateIdle(teammateName?: any) {
  const output = execFileSync(process.execPath, [TEAMMATE_IDLE], {
    input: JSON.stringify({
      session_id: 'the-teammate-own-session',
      transcript_path: path.join(PROJECT, 'teammate.jsonl'),
      cwd: PROJECT,
      permission_mode: 'bypassPermissions',
      agent_type: 'general-purpose',
      hook_event_name: 'TeammateIdle',
      teammate_name: teammateName,
      team_name: 'sidequest',
    }),
    encoding: 'utf8',
    env: { ...process.env, SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: PROJECT },
  });
  return output.trim() ? JSON.parse(output) : null;
}

// Those same fields must not be able to veto a match: only an exact agent id or
// an exact agent name may prove identity.
function finishDispatch(title?: any, options: any = {}) {
  const ticket = store.createTicket(slug, { title, category: 'dispatch.lifecycle', source: 'test' });
  const sessionId = options.sessionId || `idle-${ticket.id}`;
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
  const executor = prepared.ticket.dispatchExecutor;
  const agentName = options.agentName || `idle-teammate-${ticket.id}`;
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, { sessionId, token: prepared.token, executor, agentName }).ok, true);
  if (options.agentId) assert.equal(store.bindDispatchAgent(sessionId, executor, options.agentId, agentName).ok, true);
  const by = `idle-worker-${ticket.id}`;
  assert.equal(store.claimTicket(slug, ticket.ref, by, { sessionId, token: prepared.token, executor }).ok, true);
  if (options.terminal !== false) {
    const done = store.completeTicket(slug, ticket.ref, by, { sessionId });
    assert.equal(done.ok, true, `completeTicket refused: ${done.reason}`);
  }
  return { ref: ticket.ref, sessionId, executor, agentName };
}

test('an unbound terminal dispatch is matched by teammate name alone', () => {
  const dispatch = finishDispatch('unbound terminal dispatch');
  assert.equal(store.pulsePayload(slug, dispatch.ref).dispatch.agentId, null);

  const matched = store.terminalDispatchForIdle({
    sessionId: 'the-teammate-own-session',
    agentId: '',
    agentName: dispatch.agentName,
    executor: 'general-purpose',
  });
  assert.equal(matched?.ref, dispatch.ref);
  assert.equal(matched.outcome, 'done');
});

test('a bound terminal dispatch still matches on agent id', () => {
  const agentId = `bound-agent-${Date.now()}`;
  const dispatch = finishDispatch('bound terminal dispatch', { agentId });
  assert.equal(store.terminalDispatchForIdle({ sessionId: '', agentId, agentName: '', executor: '' })?.ref, dispatch.ref);
});

test('session and executor alone never identify a teammate', () => {
  const dispatch = finishDispatch('terminal dispatch with no name evidence');
  assert.equal(store.terminalDispatchForIdle({
    sessionId: dispatch.sessionId,
    agentId: 'some-unrelated-agent-id',
    agentName: 'some-unrelated-teammate',
    executor: dispatch.executor,
  }), null);
});

test('an ambiguous teammate name leaves both teammates alone', () => {
  const agentName = `shared-idle-name-${Date.now()}`;
  finishDispatch('first dispatch sharing a name', { agentName });
  finishDispatch('second dispatch sharing a name', { agentName });
  assert.equal(store.terminalDispatchForIdle({ sessionId: '', agentId: '', agentName, executor: '' }), null);
});

test('a working dispatch is never matched, however well its identity lines up', () => {
  const dispatch = finishDispatch('still working dispatch', { terminal: false });
  assert.equal(store.terminalDispatchForIdle({
    sessionId: dispatch.sessionId,
    agentId: '',
    agentName: dispatch.agentName,
    executor: dispatch.executor,
  }), null);
});

// SQ-923: a shared-tree executor commits on the integration branch itself, so
// "wrote nothing" and "committed and never submitted" look identical after the
// fact unless the dispatch remembers where the run started.
test('a prepared dispatch records the commit its run starts from, and where its executor works', () => {
  const ticket = createFixture('dispatch baseline for closeout proof');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT, encoding: 'utf8' }).trim();
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: 'baseline-session' });
  assert.equal(prepared.ticket.dispatch.baseCommit, head);

  assert.equal(store.dispatchWorkspace(slug, prepared.ticket), null, 'an unbound isolated dispatch has no locatable worktree');
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    sessionId: 'baseline-session',
    agentName: 'baseline-agent',
  }).ok, true);
  assert.equal(store.bindDispatchAgent('baseline-session', prepared.ticket.dispatchExecutor, 'a923baseline', 'baseline-agent').ok, true);
  const worktree = path.join(PROJECT, '.claude', 'worktrees', 'agent-a923baseline');
  assert.equal(store.dispatchWorkspace(slug, store.getTicket(slug, ticket.ref)), null, 'a worktree that is not there is not a workspace');
  execFileSync('git', ['worktree', 'add', '--quiet', '-b', 'agent-a923baseline', worktree, 'HEAD'], { cwd: PROJECT });
  assert.deepEqual(store.dispatchWorkspace(slug, store.getTicket(slug, ticket.ref)), { root: worktree, base: head });

  const shared = createFixture('shared-tree dispatch baseline');
  const preparedShared = store.prepareDispatch(slug, shared.ref, { sharedTree: true });
  assert.deepEqual(store.dispatchWorkspace(slug, preparedShared.ticket), { root: PROJECT, base: head });
});

test('SQ-971: a dispatch records its feature integration target separately from board config', () => {
  const branch = `feature-target-${Date.now()}`;
  const defaultHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT, encoding: 'utf8' }).trim();
  const featureHead = execFileSync('git', ['commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'feature target base'], { cwd: PROJECT, encoding: 'utf8' }).trim();
  execFileSync('git', ['update-ref', `refs/heads/${branch}`, featureHead], { cwd: PROJECT });
  const ticket = createFixture('feature integration target');
  const prepared = store.prepareDispatch(slug, ticket.ref, {
    sessionId: 'feature-target-session',
    integrationBranch: branch,
    integrationMode: 'local',
  });
  assert.deepEqual(prepared.ticket.dispatch.integrationTarget, {
    mode: 'local',
    upstream: branch,
    branch,
  });
  assert.equal(prepared.ticket.dispatch.baseCommit, featureHead);
  assert.notEqual(prepared.ticket.dispatch.baseCommit, defaultHead);
  assert.notEqual(store.boardConfig(slug).integrationBranch, branch);
});

test('an explicit missing integration branch refuses with its exact ref', () => {
  const branch = `missing-target-${Date.now()}`;
  const ticket = createFixture('missing feature integration target');
  assert.throws(() => store.prepareDispatch(slug, ticket.ref, {
    integrationBranch: branch,
    integrationMode: 'local',
  }), new RegExp(`refs/heads/${branch}`));
  assert.equal(store.getTicket(slug, ticket.ref).dispatch, undefined);
});

export {};
