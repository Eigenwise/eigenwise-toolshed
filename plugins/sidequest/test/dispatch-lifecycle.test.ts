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
  store.setCategory({ id, name: id, route: { model: 'sonnet', effort: 'high' }, fallback: null, readonly: true, artifactRoots: id === 'codebase-exploration' ? ['.claude/.codebase-info'] : [], enabled: true });
}

function createFixture(title?: any, category = 'dispatch.lifecycle') {
  return store.createTicket(slug, {
    title,
    category,
    files: ['tracked.js'],
    source: 'test',
  });
}

function commitFixtureChange() {
  fs.appendFileSync(path.join(PROJECT, 'tracked.js'), 'module.exports = 1;\n');
  execFileSync('git', ['add', 'tracked.js'], { cwd: PROJECT });
  execFileSync('git', ['commit', '--quiet', '-m', 'fixture change'], { cwd: PROJECT });
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

  runLifecycleHook(SUBAGENT_START, {
    session_id: sessionId,
    agent_type: executor,
    agent_name: 'batch-lifecycle-worker',
  });
  for (const ref of [first.ref, second.ref]) {
    const dispatch = store.getTicket(slug, ref).dispatch;
    assert.ok(dispatch.boundAt);
    assert.equal(dispatch.agentId ?? null, null);
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

test('same-name launches on different projects remain ambiguous', () => {
  const otherProject = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-dispatch-lifecycle-other-project-'));
  const otherSlug = store.ensureProject(otherProject).slug;
  const first = store.createTicket(slug, { title: 'cross-project identity fixture', category: 'dispatch.lifecycle', source: 'test' });
  const second = store.createTicket(otherSlug, { title: 'cross-project identity fixture', category: 'dispatch.lifecycle', source: 'test' });
  const sessionId = `cross-project-${Date.now()}`;
  const agentName = 'same-project-local-launch-name';
  const firstPrepared = store.prepareDispatch(slug, first.ref, { sessionId, sharedTree: true });
  const secondPrepared = store.prepareDispatch(otherSlug, second.ref, { sessionId, sharedTree: true });
  const prepared: Array<[string, any]> = [
    [slug, firstPrepared],
    [otherSlug, secondPrepared],
  ];
  const executor = firstPrepared.ticket.dispatchExecutor;

  for (const [projectSlug, launch] of prepared) {
    assert.equal(launch.ticket.dispatchExecutor, executor);
    assert.equal(store.recordDispatchLaunch(projectSlug, launch.ticket.ref, {
      sessionId,
      token: launch.token,
      executor,
      agentName,
    }).ok, true);
  }

  runLifecycleHook(SUBAGENT_START, {
    session_id: sessionId,
    agent_type: executor,
    agent_name: agentName,
  });
  assert.equal(store.bindDispatchAgent(sessionId, executor, null, agentName).reason, 'ambiguous');
  assert.equal(store.markDispatchStopped(sessionId, executor, 'cross-project-agent', agentName).reason, 'ambiguous');
  for (const [projectSlug, launch] of prepared) {
    const dispatch = store.getTicket(projectSlug, launch.ticket.ref).dispatch;
    assert.equal(dispatch.boundAt, null);
    assert.equal(dispatch.agentId ?? null, null);
    assert.equal(dispatch.outcome, 'launched');
  }
});

test('shared-tree agents bind by name before SubagentStop supplies their id', () => {
  const ticket = createFixture('shared-tree identity fallback fixture');
  const sessionId = `shared-tree-${Date.now()}`;
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId, sharedTree: true });
  const executor = prepared.ticket.dispatchExecutor;
  const agentName = `shared-tree-agent-${ticket.id}`;
  const agentId = `shared-tree-native-${ticket.id}`;
  assert.equal(prepared.ticket.dispatch.sharedTree, true);
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    sessionId,
    token: prepared.token,
    executor,
    agentName,
  }).ok, true);
  assert.deepEqual(dispatchBindingCounts([ticket.ref]), { launched: 1, unbound: 1, noAgentId: 1 });

  runLifecycleHook(SUBAGENT_START, {
    session_id: sessionId,
    agent_type: executor,
    agent_name: agentName,
  });
  let dispatch = store.getTicket(slug, ticket.ref).dispatch;
  assert.deepEqual(dispatchBindingCounts([ticket.ref]), { launched: 1, unbound: 0, noAgentId: 1 });
  assert.ok(dispatch.boundAt);
  assert.equal(dispatch.agentId ?? null, null);
  assert.equal(dispatch.worktree, undefined);
  const boundAt = dispatch.boundAt;

  const by = `shared-tree-worker-${ticket.id}`;
  assert.equal(store.claimTicket(slug, ticket.ref, by, {
    sessionId,
    token: prepared.token,
    executor,
  }).ok, true);
  commitFixtureChange();
  assert.equal(store.submitTicket(slug, ticket.ref, by, {
    commit: 'abc1234def5678',
    sessionId,
    source: 'test',
  }).ok, true);
  dispatch = store.getTicket(slug, ticket.ref).dispatch;
  assert.deepEqual(dispatchBindingCounts([ticket.ref]), { launched: 1, unbound: 0, noAgentId: 1 });
  assert.equal(dispatch.outcome, 'submitted');
  assert.equal(dispatch.agentId ?? null, null);
  const terminalAt = dispatch.terminalAt;
  const terminalSource = dispatch.terminalSource;
  assert.equal(store.markDispatchStopped(sessionId, executor, 'unrelated-id', 'unrelated-name').reason, 'not_found');
  const verdict = runLifecycleHook(SUBAGENT_STOP, {
    session_id: sessionId,
    agent_type: executor,
    agent_id: agentId,
    agent_name: agentName,
  });

  dispatch = store.getTicket(slug, ticket.ref).dispatch;
  assert.match(JSON.stringify(verdict), new RegExp(`${ticket.ref} READY_FOR_INTEGRATION`));
  assert.deepEqual(dispatchBindingCounts([ticket.ref]), { launched: 1, unbound: 0, noAgentId: 0 });
  assert.equal(dispatch.agentId, agentId);
  assert.equal(dispatch.boundAt, boundAt);
  assert.equal(dispatch.outcome, 'submitted');
  assert.equal(dispatch.terminalAt, terminalAt);
  assert.equal(dispatch.terminalSource, terminalSource);
});

test('SubagentStop backfills identity and worktree for an isolated dispatch missed at start', () => {
  const ticket = createFixture('isolated stop fallback fixture');
  const sessionId = `isolated-stop-${Date.now()}`;
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId, sharedTree: false });
  const executor = prepared.ticket.dispatchExecutor;
  const agentName = `isolated-stop-agent-${ticket.id}`;
  const agentId = `isolated-stop-native-${ticket.id}`;
  assert.equal(prepared.ticket.dispatch.sharedTree, false);
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    sessionId,
    token: prepared.token,
    executor,
    agentName,
  }).ok, true);
  assert.deepEqual(dispatchBindingCounts([ticket.ref]), { launched: 1, unbound: 1, noAgentId: 1 });
  assert.equal(store.claimTicket(slug, ticket.ref, `isolated-stop-worker-${ticket.id}`, {
    sessionId,
    token: prepared.token,
    executor,
  }).ok, true);

  runLifecycleHook(SUBAGENT_STOP, {
    session_id: sessionId,
    agent_type: executor,
    agent_id: agentId,
    agent_name: agentName,
  });

  const dispatch = store.getTicket(slug, ticket.ref).dispatch;
  assert.deepEqual(dispatchBindingCounts([ticket.ref]), { launched: 1, unbound: 0, noAgentId: 0 });
  assert.equal(dispatch.agentId, agentId);
  assert.ok(dispatch.boundAt);
  assert.equal(dispatch.worktree, path.join(PROJECT, '.claude', 'worktrees', `agent-${agentId}`));
  assert.equal(dispatch.outcome, 'stopped_claimed');
});

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

  const artifactWrite = store.createTicket(slug, {
    title: 'codebase artifact fixture',
    category: 'codebase-exploration',
    files: ['.claude\\.codebase-info\\modules.md'],
    contracts: { changes: ['.claude/.codebase-info/INDEX.md'] },
    source: 'test',
  });
  const artifactTicket = store.getTicket(slug, artifactWrite.ref);
  assert.equal(artifactTicket.readonlyOverride, null);
  assert.doesNotMatch(store.ticketPlanningWarnings(artifactTicket).join('\n'), /Readonly category contradicts declared write intent/);
  assert.doesNotMatch(store.dispatchWarnings(artifactTicket).join('\n'), /readonly override active|Readonly category contradicts declared write intent/);

  const outsideArtifactRoot = store.createTicket(slug, {
    title: 'outside codebase artifact fixture',
    category: 'codebase-exploration',
    files: ['.claude/.codebase-info/modules.md', 'src/index.ts', '.claude/.codebase-infoXYZ/not-a-map.md'],
    source: 'test',
  });
  const outsideWarning = store.ticketPlanningWarnings(store.getTicket(slug, outsideArtifactRoot.ref)).join('\n');
  assert.match(outsideWarning, /Readonly category contradicts declared write intent/);
  assert.match(outsideWarning, /src\/index\.ts/);
  assert.match(outsideWarning, /\.claude\/\.codebase-infoXYZ\/not-a-map\.md/);

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

test('prepared dispatches expire on the configured TTL with an audit comment', () => {
  const ticket = createFixture('prepared expiry fixture');
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: 'prepared-expiry' });
  const expiresAt = Date.parse(prepared.ticket.dispatch.preparedAt) + store.preparedDispatchTtlMs() + 1;

  const swept = store.sweepStaleDispatches({ project: slug, now: expiresAt, source: 'test' });
  assert.deepEqual(swept.expired.map((entry?: any) => entry.ref), [ticket.ref]);
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

test('ordinary, resumed, and reworked launches all carry a readable name and the route prefix', () => {
  const ticket = createFixture('Rebuild the release engine safely');
  const sessionId = `launch-name-${Date.now()}`;
  const ordinary = store.prepareDispatch(slug, ticket.ref, { sessionId });
  const executor = ordinary.ticket.dispatchExecutor;
  assert.equal(ordinary.ticket.dispatch.launchName, `${ticket.ref.toLowerCase()}-rebuild-release-engine`);
  assert.equal(ordinary.ticket.dispatch.description, `[model=Claude Sonnet effort=high] ${ticket.title}`);

  // Re-preparing before anything launched keeps the name: no agent wears it yet.
  const resumed = store.prepareDispatch(slug, ticket.ref, { sessionId });
  assert.notEqual(resumed.token, ordinary.token);
  assert.equal(resumed.ticket.dispatch.launchName, ordinary.ticket.dispatch.launchName);
  assert.equal(resumed.ticket.dispatch.launchSeq, 1);

  const prompt = `Ref: ${ticket.ref}\n--project "${PROJECT}" --token ${resumed.token}`;
  const launch = runForceBypass({
    session_id: sessionId,
    cwd: PROJECT,
    tool_name: 'Agent',
    tool_input: { subagent_type: executor, model: 'sonnet', name: 'orchestrator-invented-name', description: 'paraphrased', prompt },
  });
  assert.equal(launch.hookSpecificOutput.updatedInput.name, resumed.ticket.dispatch.launchName);
  assert.equal(launch.hookSpecificOutput.updatedInput.description, resumed.ticket.dispatch.description);
  assert.match(launch.systemMessage, /corrected prepared dispatch description and name/);

  assert.equal(store.claimTicket(slug, ticket.ref, 'launch-name-worker', {
    sessionId, token: resumed.token, executor,
  }).ok, true);
  assert.equal(store.releaseTicket(slug, ticket.ref, 'launch-name-worker', { status: 'todo', source: 'test' }).ok, true);

  // Rework redispatch: an agent already ran under sequence 1, so the name counts up.
  const rework = store.prepareDispatch(slug, ticket.ref, { sessionId });
  assert.equal(rework.ticket.dispatch.launchSeq, 2);
  assert.equal(rework.ticket.dispatch.launchName, `${ticket.ref.toLowerCase()}-rebuild-release-engine-2`);
  const reworkLaunch = runForceBypass({
    session_id: sessionId,
    cwd: PROJECT,
    tool_name: 'Agent',
    tool_input: {
      subagent_type: executor,
      model: 'sonnet',
      name: rework.ticket.dispatch.launchName,
      description: rework.ticket.dispatch.description,
      prompt: `Ref: ${ticket.ref}\n--project "${PROJECT}" --token ${rework.token}`,
    },
  });
  assert.equal(reworkLaunch.hookSpecificOutput.permissionDecision, undefined);
  assert.equal(reworkLaunch.systemMessage, undefined);
  assert.equal(store.pulsePayload(slug, ticket.ref).dispatch.agentName, rework.ticket.dispatch.launchName);
});

test('a launch whose board record is unreachable still names itself after the ref', () => {
  const unregistered = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-unregistered-'));
  const launch = runForceBypass({
    session_id: 'orphan-launch',
    cwd: PROJECT,
    tool_name: 'Agent',
    tool_input: {
      subagent_type: 'sidequest-exec-high',
      model: 'sonnet',
      description: 'orphan launch',
      prompt: `Work SQ-999999 --project "${unregistered}" --token not-a-real-token`,
    },
  });
  assert.equal(launch.hookSpecificOutput.updatedInput.name, 'sq-999999');
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

test('the harness TeammateIdle payload ends an unbound terminal executor', () => {
  const dispatch = finishDispatch('unbound dispatch meeting the real payload');
  assert.deepEqual(runTeammateIdle(dispatch.agentName), {
    continue: false,
    stopReason: `sidequest: ${dispatch.ref} is terminal (done); end this idle executor.`,
  });
});

test('the harness TeammateIdle payload leaves a working executor alone', () => {
  const dispatch = finishDispatch('working dispatch meeting the real payload', { terminal: false });
  assert.equal(runTeammateIdle(dispatch.agentName), null);
});

test('SQ-971: TeammateIdle leaves a claimed rejected-submission checkpoint active', () => {
  const ticket = createFixture('rejected submission idle checkpoint');
  const sessionId = `rejected-idle-${ticket.id}`;
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
  const executor = prepared.ticket.dispatchExecutor;
  const agentName = `rejected-idle-agent-${ticket.id}`;
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, { sessionId, token: prepared.token, executor, agentName }).ok, true);
  const by = `rejected-idle-worker-${ticket.id}`;
  assert.equal(store.claimTicket(slug, ticket.ref, by, { sessionId, token: prepared.token, executor }).ok, true);
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT, encoding: 'utf8' }).trim();
  execFileSync('git', ['update-ref', `refs/sidequest/${ticket.ref}-rejected`, commit], { cwd: PROJECT });
  assert.equal(store.checkpointTicket(slug, ticket.ref, by, {
    commit,
    worktree: PROJECT,
    verify: 'npm test passed',
    kind: 'submission_rejected',
    gitRef: `refs/sidequest/${ticket.ref}-rejected`,
    failure: { reason: 'base_not_reachable', message: 'fixture' },
  }).ok, true);

  assert.equal(runTeammateIdle(agentName), null);
  const after = store.getTicket(slug, ticket.ref);
  assert.equal(after.claim.by, by);
  assert.equal(after.dispatch.terminalAt, null);
  assert.equal(after.checkpoint.kind, 'submission_rejected');
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
