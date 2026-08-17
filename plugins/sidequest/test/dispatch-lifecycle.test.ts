import './_temp-cleanup.js';
import './_gateway-catalog-freshness.js';
import './_sidequest-install-fixture.js';
import './_hook-runtime.js';
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
  updatedAt: new Date().toISOString(),
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
execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: PROJECT });
execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: PROJECT });
execFileSync('git', ['config', 'user.name', 'Dispatch Lifecycle Test'], { cwd: PROJECT });
fs.writeFileSync(path.join(PROJECT, 'tracked.js'), 'module.exports = 1;\n');
execFileSync('git', ['add', 'tracked.js'], { cwd: PROJECT });
execFileSync('git', ['commit', '--quiet', '-m', 'seed fixture'], { cwd: PROJECT });

const store = require('../lib/store.js');
const worktrees = require('../lib/worktrees.js');
const worktreeLease = require('../lib/kernel/worktree.js');
const agentsync = require('../lib/agentsync.js');
const { claimRefusalMessage } = require('../lib/refusal-guidance.js');
const FORCE_EXEC_BYPASS = path.join(__dirname, '..', 'hooks', 'force-exec-bypass.js');
const SUBAGENT_START = path.join(__dirname, '..', 'hooks', 'subagent-start.js');
const SUBAGENT_STOP = path.join(__dirname, '..', 'hooks', 'subagent-stop.js');
const slug = store.ensureProject(PROJECT).slug;

function markCheckoutInstance(worktree: string): void {
  const gitDirectoryValue = execFileSync('git', ['rev-parse', '--git-dir'], { cwd: worktree, encoding: 'utf8', windowsHide: true }).trim();
  const gitDirectory = path.isAbsolute(gitDirectoryValue) ? gitDirectoryValue : path.resolve(worktree, gitDirectoryValue);
  worktreeLease.createCheckoutInstanceMarker(gitDirectory);
}

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

test('executors cannot prepare a shared-tree child dispatch while the orchestrator can', () => {
  const executorSessionId = `executor-dispatch-guard-${Date.now()}`;
  const orchestratorSessionId = `orchestrator-dispatch-guard-${Date.now()}`;
  const held = createFixture('executor-held dispatch guard');
  const heldDispatch = store.prepareDispatch(slug, held.ref, { sessionId: orchestratorSessionId });
  assert.equal(store.claimTicket(slug, held.ref, 'executor-dispatch-guard', {
    token: heldDispatch.token,
    executor: heldDispatch.ticket.dispatchExecutor,
    sessionId: executorSessionId,
  }).ok, true);

  const subordinate = createFixture('subordinate dispatch guard');
  assert.throws(
    () => store.prepareDispatch(slug, subordinate.ref, { sessionId: executorSessionId, sharedTree: true }),
    new RegExp(`dispatch: refused while you hold ${held.ref}\\. Executors cannot dispatch child tickets`),
  );
  assert.equal(store.getTicket(slug, subordinate.ref).dispatchNonce, null);

  const orchestrated = store.prepareDispatch(slug, subordinate.ref, { sessionId: orchestratorSessionId, sharedTree: true, runtimeCwd: PROJECT });
  assert.equal(orchestrated.ok, true);
  assert.equal(orchestrated.ticket.dispatch.sharedTree, true);
  assert.equal(store.releaseTicket(slug, held.ref, 'executor-dispatch-guard', { status: 'todo', source: 'test' }).ok, true);
  assert.equal(store.releaseTicket(slug, subordinate.ref, 'orchestrator-dispatch-guard', { force: true, status: 'todo', source: 'test' }).ok, true);
});

test('shared-tree admission requires the project checkout while artifacts remain orchestrator-dispatchable', () => {
  const linkedWorktree = path.join(os.tmpdir(), `sq-shared-tree-runtime-${Date.now()}`);
  execFileSync('git', ['worktree', 'add', '--detach', linkedWorktree, 'HEAD'], { cwd: PROJECT });
  try {
    const rejected = createFixture('shared-tree linked runtime rejection');
    assert.throws(
      () => store.prepareDispatch(slug, rejected.ref, { sharedTree: true, runtimeCwd: linkedWorktree }),
      /sharedTree:true requires the spawning runtime to be rooted in the declared project checkout/,
    );
    assert.equal(store.getTicket(slug, rejected.ref).dispatchNonce, null);

    store.setCategory({ id: 'shared-tree-artifact', name: 'Shared tree artifact', route: { model: 'sonnet', effort: 'high' }, artifactRoots: ['tracked.js'] });
    const artifact = store.createTicket(slug, {
      title: 'orchestrator shared-tree artifact',
      category: 'shared-tree-artifact',
      description: store.SHARED_TREE_ARTIFACT_MARKER,
      files: ['tracked.js'],
      source: 'test',
    });
    const prepared = store.prepareDispatch(slug, artifact.ref, { sharedTree: true, runtimeCwd: PROJECT });
    assert.equal(prepared.ticket.dispatch.sharedTree, true);
    assert.equal(prepared.ticket.dispatch.artifactMode, true);
    assert.equal(store.releaseTicket(slug, artifact.ref, 'shared-tree-artifact-cleanup', { force: true, status: 'todo', source: 'test' }).ok, true);
  } finally {
    execFileSync('git', ['worktree', 'remove', '--force', linkedWorktree], { cwd: PROJECT });
  }
});

function windowsShortPathAlias(directory = '') {
  if (process.platform !== 'win32') return null;
  const result = spawnSync('cmd.exe', ['/d', '/s', '/c', `for %I in ("${directory}") do @echo %~sI`], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const alias = result.status === 0 ? result.stdout.trim() : '';
  if (!alias || alias.toLowerCase() === directory.toLowerCase()) return null;
  try {
    return fs.realpathSync.native(alias) === fs.realpathSync.native(directory) ? alias : null;
  } catch (error) {
    return null;
  }
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

test('scope drift ignores always-in-scope paths and preserves declared casing for real drift', () => {
  const scopeDriftProject = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-scope-drift-project-'));
  execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: scopeDriftProject });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: scopeDriftProject });
  execFileSync('git', ['config', 'user.name', 'Scope Drift Test'], { cwd: scopeDriftProject });
  fs.writeFileSync(path.join(scopeDriftProject, 'tracked.js'), 'module.exports = 1;\n');
  execFileSync('git', ['add', 'tracked.js'], { cwd: scopeDriftProject });
  execFileSync('git', ['commit', '--quiet', '-m', 'seed fixture'], { cwd: scopeDriftProject });
  const scopeDriftSlug = store.ensureProject(scopeDriftProject).slug;
  assert.equal(store.setBoardConfig(scopeDriftSlug, { alwaysInScope: ['docs/'] }).ok, true);
  const docsOnly = store.createTicket(scopeDriftSlug, {
    title: 'always-in-scope scope fixture',
    category: 'dispatch.lifecycle',
    files: ['tracked.js'],
    source: 'test',
  });
  const realDrift = store.createTicket(scopeDriftSlug, {
    title: 'real scope drift fixture',
    category: 'dispatch.lifecycle',
    files: ['CamelCase.js'],
    source: 'test',
  });
  try {
    const preparedDocsOnly = store.prepareDispatch(scopeDriftSlug, docsOnly.ref, { sessionId: `scope-drift-docs-${Date.now()}` });
    assert.deepEqual(preparedDocsOnly.ticket.dispatch.declaredFiles, ['tracked.js', 'docs/', `.release/unreleased/${docsOnly.ref}.md`]);
    assert.deepEqual(store.pulsePayload(scopeDriftSlug, docsOnly.ref).scope.declared, ['tracked.js', 'docs/', `.release/unreleased/${docsOnly.ref}.md`]);
    assert.equal(store.pulsePayload(scopeDriftSlug, docsOnly.ref).warnings, undefined);

    store.prepareDispatch(scopeDriftSlug, realDrift.ref, { sessionId: `scope-drift-real-${Date.now()}` });
    assert.equal(store.setBoardConfig(scopeDriftSlug, { alwaysInScope: [] }).ok, true);
    assert.deepEqual(store.pulsePayload(scopeDriftSlug, realDrift.ref).warnings, [
      `Scope drift: this live dispatch enforces .release/unreleased/${realDrift.ref}.md, CamelCase.js, docs but the ticket declares .release/unreleased/${realDrift.ref}.md, CamelCase.js. Commits are gated on the dispatch set; re-run update --files to resync.`,
    ]);
  } finally {
    store.deleteTicket(scopeDriftSlug, docsOnly.ref);
    store.deleteTicket(scopeDriftSlug, realDrift.ref);
  }
});

test('batch launch records every prepared ticket and binds the shared native agent', () => {
  const first = createFixture('first batch lifecycle fixture');
  const second = createFixture('second batch lifecycle fixture');
  const sessionId = `batch-${Date.now()}`;
  const firstPrepared = store.prepareDispatch(slug, first.ref, { sessionId, sharedTree: true });
  const secondPrepared = store.prepareDispatch(slug, second.ref, { sessionId, sharedTree: true });
  const executor = firstPrepared.ticket.dispatchExecutor;
  assert.deepEqual(firstPrepared.ticket.dispatch.preparedBy, { sessionId, surface: 'store' });
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
    assert.equal(pulse.liveness, 'unknown');
  }
});

test('one runtime agent cannot bind concurrently launched isolated dispatches', () => {
  const first = createFixture('first isolated runtime identity fixture');
  const second = createFixture('second isolated runtime identity fixture');
  const sessionId = `isolated-runtime-identity-${Date.now()}`;
  const agentName = 'isolated-runtime-identity-worker';
  const prepared = [
    store.prepareDispatch(slug, first.ref, { sessionId, sharedTree: false }),
    store.prepareDispatch(slug, second.ref, { sessionId, sharedTree: false }),
  ];
  const executor = prepared[0].ticket.dispatchExecutor;

  for (const launch of prepared) {
    assert.equal(store.recordDispatchLaunch(slug, launch.ticket.ref, {
      sessionId,
      token: launch.token,
      executor,
      agentName,
    }).ok, true);
  }

  const bound = store.bindDispatchAgent(sessionId, executor, 'isolated-runtime-agent', agentName);
  assert.equal(bound.reason, 'ambiguous');
  for (const ref of [first.ref, second.ref]) {
    const dispatch = store.getTicket(slug, ref).dispatch;
    assert.equal(dispatch.agentId ?? null, null);
    assert.equal(dispatch.worktree, undefined);
  }
});

test('claim-token binding accepts prepared and launched attempts', () => {
  const fixture = createFixture('claim token compatibility fixture');
  const sessionId = `claim-token-compatibility-${Date.now()}`;
  const prepared = store.prepareDispatch(slug, fixture.ref, { sessionId, sharedTree: false });
  const claimOptions = {
    sessionId,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    requireBoundAgent: true,
  };

  assert.equal(store.claimTicket(slug, fixture.ref, 'claim-token-compatibility-worker', claimOptions).ok, true);
  const dispatch = store.getTicket(slug, fixture.ref).dispatch;
  assert.equal(dispatch.bindSource, 'claim_token');
  assert.ok(dispatch.boundAt);
  assert.equal(store.getTicket(slug, fixture.ref).lifecycleAttempt.state, 'claimed');
});

test('direct claim release records the terminal lifecycle state', () => {
  const ticket = createFixture('direct release lifecycle fixture');
  const owner = 'direct-release-lifecycle-worker';
  assert.equal(store.claimTicket(slug, ticket.ref, owner, {
    direct: true,
    reason: 'The lifecycle fixture requires an exact local direct claim.',
  }).ok, true);
  assert.equal(store.getTicket(slug, ticket.ref).lifecycleAttempt.state, 'claimed');

  assert.equal(store.releaseTicket(slug, ticket.ref, owner, {
    status: 'todo',
    source: 'test',
  }).ok, true);
  const released = store.getTicket(slug, ticket.ref);
  assert.equal(released.claim, null);
  assert.equal(released.lifecycleAttempt.state, 'released');
});

test('dispatched claim release records one terminal lifecycle state', () => {
  const ticket = createFixture('dispatched release lifecycle fixture');
  const owner = 'dispatched-release-lifecycle-worker';
  const prepared = store.prepareDispatch(slug, ticket.ref, {
    sessionId: 'dispatched-release-lifecycle',
    sharedTree: true,
  });
  assert.equal(store.claimTicket(slug, ticket.ref, owner, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    sessionId: 'dispatched-release-lifecycle',
  }).ok, true);

  assert.equal(store.releaseTicket(slug, ticket.ref, owner, {
    status: 'todo',
    source: 'test',
  }).ok, true);
  const released = store.getTicket(slug, ticket.ref);
  assert.equal(released.lifecycleAttempt.state, 'released');
  assert.equal(released.dispatch.lifecycleAttempt.state, 'released');
});

test('one runtime cannot claim two isolated dispatches at once', () => {
  const first = createFixture('first runtime claim fixture');
  const second = createFixture('second runtime claim fixture');
  const sessionId = `runtime-claim-${Date.now()}`;
  const prepared = [
    store.prepareDispatch(slug, first.ref, { sessionId, sharedTree: false }),
    store.prepareDispatch(slug, second.ref, { sessionId, sharedTree: false }),
  ];

  for (const launch of prepared) {
    assert.equal(store.recordDispatchLaunch(slug, launch.ticket.ref, {
      sessionId,
      token: launch.token,
      executor: launch.ticket.dispatchExecutor,
      agentName: `runtime-claim-worker-${launch.ticket.id}`,
    }).ok, true);
  }

  assert.equal(store.claimTicket(slug, first.ref, 'runtime-claim-worker', {
    sessionId,
    token: prepared[0].token,
    executor: prepared[0].ticket.dispatchExecutor,
    requireBoundAgent: true,
  }).ok, true);
  const refused = store.claimTicket(slug, second.ref, 'runtime-claim-worker', {
    sessionId,
    token: prepared[1].token,
    executor: prepared[1].ticket.dispatchExecutor,
    requireBoundAgent: true,
  });
  assert.equal(refused.reason, 'runtime_claimed');
  assert.match(refused.message, new RegExp(`already holds ${first.ref}`));
  assert.equal(store.releaseTicket(slug, first.ref, 'runtime-claim-worker', { status: 'todo', source: 'test' }).ok, true);
  assert.equal(store.claimTicket(slug, second.ref, 'runtime-claim-worker', {
    sessionId,
    token: prepared[1].token,
    executor: prepared[1].ticket.dispatchExecutor,
    requireBoundAgent: true,
  }).ok, true);
  assert.equal(store.releaseTicket(slug, second.ref, 'runtime-claim-worker', { status: 'todo', source: 'test' }).ok, true);
});

test('launched dispatches without an executor identity, claim, or checkpoint are stalled', () => {
  const ticket = createFixture('stalled dispatch fixture');
  const sessionId = `stalled-${Date.now()}`;
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
  const executor = prepared.ticket.dispatchExecutor;
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    sessionId,
    token: prepared.token,
    executor,
    agentName: `stalled-agent-${ticket.id}`,
  }).ok, true);

  const pulse = store.pulsePayload(slug, ticket.ref);
  assert.equal(pulse.liveness, 'stalled');
  assert.match(pulse.livenessEvidence, /without a bound runtime identity, claim, or checkpoint/);
  const changed = store.changesPayload(slug, new Date(0).toISOString()).tickets.find((entry?: any) => entry.ref === ticket.ref);
  assert.equal(changed.liveness, 'stalled');

  assert.equal(store.bindDispatchAgent(sessionId, executor, `stalled-agent-${ticket.id}`, `stalled-agent-${ticket.id}`).ok, true);
  assert.equal(store.pulsePayload(slug, ticket.ref).liveness, 'unknown');
});

test('same-name launches on different projects remain ambiguous', () => {
  const otherProject = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-dispatch-lifecycle-other-project-'));
  const otherSlug = store.ensureProject(otherProject).slug;
  const first = store.createTicket(slug, { title: 'cross-project identity fixture', category: 'dispatch.lifecycle', files: ['tracked.js'], source: 'test' });
  const second = store.createTicket(otherSlug, { title: 'cross-project identity fixture', category: 'dispatch.lifecycle', files: ['tracked.js'], source: 'test' });
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

test('SubagentStop backfills identity but never invents a worktree binding', () => {
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
  assert.equal(store.claimTicket(slug, ticket.ref, `token-bound-isolated-worker-${ticket.id}`, {
    sessionId,
    token: prepared.token,
    executor,
    requireBoundAgent: true,
  }).ok, true);
  assert.equal(store.getTicket(slug, ticket.ref).dispatch.bindSource, 'claim_token');

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
  assert.equal(dispatch.worktree, undefined);
  assert.equal(dispatch.outcome, 'claimed');
  assert.ok(dispatch.turnEndedAt);
});

test('zero-scope read-only dispatches isolate by default and preserve explicit checkout choice', () => {
  const ticket = store.createTicket(slug, {
    title: 'zero-scope read-only isolated checkout',
    category: 'research',
    source: 'test',
  });
  const sessionId = `zero-scope-readonly-${Date.now()}`;
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
  assert.equal(prepared.ticket.dispatch.readonly, true);
  assert.equal(prepared.ticket.dispatch.sharedTree, false);
  assert.equal(prepared.ticket.dispatchExecutor, 'sidequest-exec-readonly-high');
  assert.equal(agentsync.ticketIsolation(prepared.ticket, prepared.ticket.dispatch.sharedTree), 'worktree');
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    sessionId,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    agentName: 'zero-scope-readonly-worker',
  }).ok, true);
  assert.equal(store.bindDispatchAgent(sessionId, prepared.ticket.dispatchExecutor, 'zero-scope-readonly-agent', 'zero-scope-readonly-worker').ok, true);
  assert.equal(store.getTicket(slug, ticket.ref).dispatch.worktree, undefined);
  assert.equal(store.claimTicket(slug, ticket.ref, 'zero-scope-readonly-worker', {
    sessionId,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    source: 'test',
  }).ok, true);
  assert.equal(store.releaseTicket(slug, ticket.ref, 'zero-scope-readonly-worker', { status: 'todo', source: 'test' }).ok, true);

  const explicitlyShared = store.prepareDispatch(slug, ticket.ref, { sharedTree: true, runtimeCwd: PROJECT });
  assert.equal(explicitlyShared.ticket.dispatch.sharedTree, true);
  assert.equal(agentsync.ticketIsolation(explicitlyShared.ticket, explicitlyShared.ticket.dispatch.sharedTree), null);
  assert.equal(store.releaseTicket(slug, ticket.ref, 'zero-scope-readonly-shared-cleanup', { status: 'todo', source: 'test', force: true }).ok, true);

  const explicitlyIsolated = store.prepareDispatch(slug, ticket.ref, { sharedTree: false });
  assert.equal(explicitlyIsolated.ticket.dispatch.sharedTree, false);
  assert.equal(store.getTicket(slug, ticket.ref).lifecycleAttempt.state, 'prepared');
  assert.equal(store.getTicket(slug, ticket.ref).dispatch.lifecycleAttempt.state, 'prepared');
  assert.equal(store.releaseTicket(slug, ticket.ref, 'zero-scope-readonly-cleanup', { status: 'todo', source: 'test', force: true }).ok, true);
});

test('review-audit dispatches inspect immutable commits from isolated worktrees by default', () => {
  const ticket = createFixture('review isolated checkout default', 'review-audit');
  const prepared = store.prepareDispatch(slug, ticket.ref);
  assert.equal(prepared.ticket.dispatch.sharedTree, false);
  assert.equal(agentsync.ticketIsolation(prepared.ticket, prepared.ticket.dispatch.sharedTree), 'worktree');

  assert.equal(store.releaseTicket(slug, ticket.ref, 'review-isolated-cleanup', { status: 'todo', source: 'test', force: true }).ok, true);
  const explicitlyShared = store.prepareDispatch(slug, ticket.ref, { sharedTree: true, runtimeCwd: PROJECT });
  assert.equal(explicitlyShared.ticket.dispatch.sharedTree, true);
  assert.equal(store.releaseTicket(slug, ticket.ref, 'review-shared-cleanup', { status: 'todo', source: 'test', force: true }).ok, true);
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
  const worktree = worktrees.agentWorktreePath(PROJECT, 'native-complete-agent');
  assert.equal(store.bindDispatchWorktreeCreation(slug, sessionId, worktree).ok, true);
  assert.equal(store.bindDispatchAgent(sessionId, executor, 'native-complete-agent', 'complete-lifecycle-worker').ok, true);
  assert.equal(worktrees.canonicalPath(store.getTicket(slug, ticket.ref).dispatch.worktree), worktrees.canonicalPath(worktree));
  fs.mkdirSync(worktree, { recursive: true });
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
  assert.equal(pulse.liveness, 'unknown');
  assert.match(pulse.livenessEvidence, /no process heartbeat/);
  assert.equal(pulse.claim.lastBoardActivityAt, pulse.claim.at);
  assert.equal(typeof pulse.claim.boardQuietMs, 'number');
  assert.match(pulse.claim.boardQuietNote, /not process liveness/);
  assert.equal(store.changesPayload(slug, since).tickets.find((entry?: any) => entry.ref === ticket.ref).lastEventType, 'dispatch');

  store.addComment(slug, ticket.ref, {
    by: 'lifecycle-worker',
    body: 'Verified the scoped lifecycle fixture.',
    source: 'test',
  });
  pulse = store.pulsePayload(slug, ticket.ref);
  assert.equal(pulse.claim.lastBoardActivityAt, store.getTicket(slug, ticket.ref).comments.at(-1).at);

  assert.equal(store.completeTicket(slug, ticket.ref, 'lifecycle-worker', {
    model: 'sonnet',
    effort: 'high',
    source: 'test',
  }).ok, false);
  assert.equal(store.releaseTicket(slug, ticket.ref, 'lifecycle-worker', { status: 'todo', source: 'test' }).ok, true);
  assert.equal(store.getTicket(slug, ticket.ref).lifecycleAttempt.state, 'released');
  assert.equal(store.completeTicketAsControlPlane(slug, ticket.ref, {
    purpose: 'grooming',
    by: 'board-groomer',
    reason: 'Verified the lifecycle fixture as complete.',
  }).ok, true);
  pulse = store.pulsePayload(slug, ticket.ref);
  assert.equal(pulse.dispatch.state, 'done');
  assert.equal(pulse.dispatch.outcome, 'done');
  assert.equal(store.getTicket(slug, ticket.ref).lastEventType, 'dispatch');
  fs.rmSync(worktree, { recursive: true, force: true });
});

test('oracle releases park awaiting-oracle without repeat guard and retain their worktree continuation', () => {
  const ticket = createFixture('oracle projection fixture');
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: `oracle-projection-${Date.now()}` });
  assert.equal(store.claimTicket(slug, ticket.ref, 'oracle-projection-worker', {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);

  assert.equal(store.releaseTicket(slug, ticket.ref, 'oracle-projection-worker', {
    status: 'awaiting-oracle',
    releaseKind: 'oracle',
    oracle: 'Rank the candidates best to worst.',
    candidate: 'abc1234',
    deliverable: 'artifacts/round-1.wav',
    source: 'test',
  }).ok, true);

  const stored = store.getTicket(slug, ticket.ref);
  assert.equal(stored.status, 'awaiting-oracle');
  assert.equal(stored.oracle.round, 1);
  const expected = `awaiting oracle since ${stored.oracle.at}, round 1, candidate abc1234, ask: Rank the candidates best to worst.`;
  assert.equal(store.pulsePayload(slug, ticket.ref).status, 'awaiting-oracle');
  assert.equal(store.pulsePayload(slug, ticket.ref).oracle.summary, expected);
  assert.equal(store.changesPayload(slug, new Date(0).toISOString()).tickets.find((entry?: any) => entry.ref === ticket.ref).oracle.summary, expected);
  assert.equal(store.listPayload(slug, { brief: true, all: true }).tickets.find((entry?: any) => entry.ref === ticket.ref).status, 'awaiting-oracle');
  assert.equal(store.prepareDispatch(slug, ticket.ref, { sessionId: `oracle-redispatch-${Date.now()}` }).ok, true);
  assert.equal(store.releaseTicket(slug, ticket.ref, 'oracle-projection-cleanup', { status: 'todo', source: 'test', force: true }).ok, true);
});

test('worktree dispatch warnings name ignored missing paths without flagging installed dependencies', () => {
  const ignoredArtifact = 'missing-visibility-artifact/output.json';
  fs.appendFileSync(path.join(PROJECT, '.git', 'info', 'exclude'), `\nmissing-visibility-artifact/\nnode_modules\n`);
  fs.mkdirSync(path.join(PROJECT, 'node_modules'), { recursive: true });
  const missing = store.createTicket(slug, {
    title: 'ignored worktree visibility fixture',
    category: 'dispatch.lifecycle',
    files: [ignoredArtifact],
    description: 'Where: missing-visibility-artifact/output.json. Contract: inspect generated output. Verify: node --test test/dispatch-lifecycle.test.ts.',
    source: 'test',
  });
  const installed = store.createTicket(slug, {
    title: 'installed dependency visibility fixture',
    category: 'dispatch.lifecycle',
    files: ['node_modules'],
    description: 'Where: node_modules. Contract: inspect installed dependencies. Verify: node --test test/dispatch-lifecycle.test.ts.',
    source: 'test',
  });

  const missingPrepared = store.prepareDispatch(slug, missing.ref, { sessionId: `visibility-missing-${Date.now()}` });
  const installedPrepared = store.prepareDispatch(slug, installed.ref, { sessionId: `visibility-installed-${Date.now()}` });
  const missingWarnings = store.dispatchWarnings(missingPrepared.ticket, slug).join('\n');
  const installedWarnings = store.dispatchWarnings(installedPrepared.ticket, slug).join('\n');

  assert.match(missingWarnings, /missing-visibility-artifact\/output\.json/);
  assert.match(missingWarnings, /sharedTree: true, or run inline/);
  assert.doesNotMatch(installedWarnings, /Worktree visibility warning/);
  assert.equal(store.releaseTicket(slug, missing.ref, 'visibility-cleanup', { status: 'todo', source: 'test', force: true }).ok, true);
  assert.equal(store.releaseTicket(slug, installed.ref, 'visibility-cleanup', { status: 'todo', source: 'test', force: true }).ok, true);
});

test('worktree dispatch warns when ignored scoped fixtures are absent from the linked worktree', () => {
  const fixtureDirectory = 'capture-app/data';
  const linkedWorktree = path.join(PROJECT, '.claude', 'worktrees', `visibility-${Date.now()}`);
  fs.appendFileSync(path.join(PROJECT, '.git', 'info', 'exclude'), `\ncapture-app/data/\ncapture-app/node_modules/\n`);
  fs.mkdirSync(path.join(PROJECT, fixtureDirectory), { recursive: true });
  fs.writeFileSync(path.join(PROJECT, fixtureDirectory, 'capture.json'), '{}\n');
  fs.mkdirSync(path.join(PROJECT, 'capture-app', 'node_modules'), { recursive: true });
  fs.mkdirSync(linkedWorktree, { recursive: true });
  const ticket = store.createTicket(slug, {
    title: 'linked worktree fixture visibility',
    category: 'dispatch.lifecycle',
    files: ['capture-app'],
    source: 'test',
  });

  try {
    const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: `linked-visibility-${Date.now()}` });
    const dispatched = {
      ...prepared.ticket,
      dispatch: { ...prepared.ticket.dispatch, worktree: linkedWorktree },
    };
    const warnings = store.dispatchWarnings(dispatched, slug).join('\n');

    assert.match(warnings, /capture-app\/data/);
    assert.match(warnings, /test results can differ from integration/);
    assert.doesNotMatch(warnings, /capture-app\/node_modules/);
  } finally {
    assert.equal(store.releaseTicket(slug, ticket.ref, 'linked-visibility-cleanup', { status: 'todo', source: 'test', force: true }).ok, true);
    fs.rmSync(path.join(PROJECT, 'capture-app'), { recursive: true, force: true });
    fs.rmSync(path.join(PROJECT, '.claude', 'worktrees'), { recursive: true, force: true });
  }
});

test('dispatch warns when compose bind-mounts the repository root into an isolated worktree', () => {
  const compose = path.join(PROJECT, 'compose.yaml');
  fs.writeFileSync(compose, 'services:\n  app:\n    volumes:\n      - .:/workspace\n');
  const ticket = createFixture('compose worktree compatibility fixture');
  try {
    const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: `compose-worktree-${Date.now()}` });
    const warnings = store.dispatchWarnings(prepared.ticket, slug).join('\n');
    assert.match(warnings, /compose\.yaml bind-mounts the repository root/);
    assert.match(warnings, /worktreeIsolation: false/);
  } finally {
    assert.equal(store.releaseTicket(slug, ticket.ref, 'compose-worktree-cleanup', { status: 'todo', source: 'test', force: true }).ok, true);
    fs.rmSync(compose, { force: true });
  }
});

test('dispatch ignores unbound terminal attempts and explains the binding failure', () => {
  const ticket = createFixture('unbound repeat failure fixture');
  for (const number of [1, 2]) {
    const sessionId = `unbound-repeat-${number}-${Date.now()}`;
    const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
    assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
      sessionId,
      token: prepared.token,
      executor: prepared.ticket.dispatchExecutor,
      agentName: `unbound-repeat-worker-${number}`,
    }).ok, true);
    assert.equal(store.recordDispatchAgentFailure(slug, ticket.ref, {
      token: prepared.token,
      executor: prepared.ticket.dispatchExecutor,
      sessionId,
      taskName: `unbound-repeat-worker-${number}`,
      error: 'Agent stopped after max_tokens',
    }).ok, true);
  }

  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: `unbound-repeat-3-${Date.now()}` });
  assert.equal(prepared.ticket.dispatch.repeatFailureOverride, undefined);
  assert.match(store.dispatchWarnings(prepared.ticket, slug).join('\n'), /last dispatches never bound.*binding.*no allowRepeatFailure/i);
  assert.equal(store.releaseTicket(slug, ticket.ref, 'unbound-repeat-cleanup', { status: 'todo', source: 'test', force: true }).ok, true);
});

test('dispatch blocks a third terminal no-commit attempt unless explicitly overridden', () => {
  const ticket = createFixture('repeat no-commit dispatch fixture');
  for (const number of [1, 2]) {
    const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: `repeat-no-commit-${number}-${Date.now()}` });
    const worker = `repeat-no-commit-worker-${number}`;
    assert.equal(store.claimTicket(slug, ticket.ref, worker, {
      token: prepared.token,
      executor: prepared.ticket.dispatchExecutor,
    }).ok, true);
    assert.equal(store.releaseTicket(slug, ticket.ref, worker, { status: 'todo', source: 'test' }).ok, true);
  }

  assert.throws(() => store.prepareDispatch(slug, ticket.ref), (error: any) => {
    assert.match(error.message, /two prior terminal no-commit dispatches.*released at/);
    assert.doesNotMatch(error.message, /Environment visibility/);
    return true;
  });
  const overridden = store.prepareDispatch(slug, ticket.ref, { allowRepeatFailure: true });
  assert.equal(overridden.ticket.dispatch.repeatFailureOverride.priorAttempts, 2);
  assert.equal(store.releaseTicket(slug, ticket.ref, 'repeat-no-commit-cleanup', { status: 'todo', source: 'test', force: true }).ok, true);
});

// The breaker is meant to catch a run that keeps dying with nothing to show,
// and its remedy is an environment hypothesis. An attempt that checkpointed a
// commit disproves that hypothesis: it read the environment fine and simply ran
// out of runway, which is the opposite situation (the-bot-resurrection SQ-611).
test('repeat contradiction releases identify the ticket premise as the likely problem', () => {
  const ticket = createFixture('repeat contradiction dispatch fixture');
  for (const number of [1, 2]) {
    const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: `repeat-contradiction-${number}-${Date.now()}` });
    const worker = `repeat-contradiction-worker-${number}`;
    assert.equal(store.claimTicket(slug, ticket.ref, worker, {
      token: prepared.token,
      executor: prepared.ticket.dispatchExecutor,
    }).ok, true);
    assert.equal(store.releaseTicket(slug, ticket.ref, worker, {
      status: 'todo',
      source: 'mcp',
      releaseKind: 'contradiction',
      releaseReason: 'The named behavior does not occur.',
      releaseEvidence: { kind: 'contradiction', command: 'node test/probe.js', outputTail: 'observed behavior differs' },
    }).ok, true);
  }

  assert.throws(() => store.prepareDispatch(slug, ticket.ref), (error: any) => {
    assert.match(error.message, /two contradiction releases/);
    assert.match(error.message, /ticket premise is likely wrong, not the executor environment/);
    assert.match(error.message, /Measure the claim, then rewrite the ticket/);
    return true;
  });
  const overridden = store.prepareDispatch(slug, ticket.ref, { allowRepeatFailure: true });
  assert.equal(overridden.ticket.dispatch.repeatFailureOverride.priorAttempts, 2);
  assert.equal(store.releaseTicket(slug, ticket.ref, 'repeat-contradiction-cleanup', { status: 'todo', source: 'test', force: true }).ok, true);
});

test('dispatch does not count an attempt that checkpointed a commit toward the repeat-failure breaker', () => {
  const ticket = createFixture('checkpointed attempt fixture');
  const checkpointCommit = '1590b92abc1234def5678abc1234def5678abcd';
  for (const number of [1, 2]) {
    const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: `checkpointed-${number}-${Date.now()}` });
    const worker = `checkpointed-worker-${number}`;
    assert.equal(store.claimTicket(slug, ticket.ref, worker, {
      token: prepared.token,
      executor: prepared.ticket.dispatchExecutor,
    }).ok, true);
    if (number === 2) {
      assert.equal(store.checkpointTicket(slug, ticket.ref, worker, {
        commit: checkpointCommit,
        verify: 'Reproduced all six anchors and ran the gate.',
      }).ok, true);
    }
    assert.equal(store.releaseTicket(slug, ticket.ref, worker, { status: 'todo', source: 'test' }).ok, true);
  }

  const attempts = store.getTicket(slug, ticket.ref).dispatch.attempts;
  assert.equal(attempts.at(-1).commit, checkpointCommit);
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: `checkpointed-3-${Date.now()}` });
  assert.equal(prepared.ticket.dispatch.repeatFailureOverride, undefined);
  assert.equal(store.releaseTicket(slug, ticket.ref, 'checkpointed-cleanup', { status: 'todo', source: 'test', force: true }).ok, true);
});



test('dispatch counts terminal Agent failures toward the repeat-failure breaker', () => {
  const ticket = createFixture('repeat terminal failure dispatch fixture');
  for (const number of [1, 2]) {
    const sessionId = `repeat-terminal-failure-${number}-${Date.now()}`;
    const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
    const executor = prepared.ticket.dispatchExecutor;
    const worker = `repeat-terminal-failure-worker-${number}`;
    assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
      sessionId,
      token: prepared.token,
      executor,
      agentName: worker,
    }).ok, true);
    assert.equal(store.bindDispatchAgent(sessionId, executor, `repeat-terminal-failure-agent-${number}`, worker).ok, true);
    assert.equal(store.claimTicket(slug, ticket.ref, worker, {
      sessionId,
      token: prepared.token,
      executor,
    }).ok, true);
    assert.equal(store.recordDispatchAgentFailure(slug, ticket.ref, {
      token: prepared.token,
      executor,
      sessionId,
      taskName: worker,
      agentId: `repeat-terminal-failure-agent-${number}`,
      agentName: worker,
      error: 'Agent stopped after max_tokens',
    }).ok, true);
    assert.equal(store.getTicket(slug, ticket.ref).dispatch.outcome, 'died');
    assert.equal(store.releaseTicket(slug, ticket.ref, worker, { status: 'todo', source: 'test' }).ok, true);
  }

  assert.throws(() => store.prepareDispatch(slug, ticket.ref), /two prior terminal no-commit dispatches.*died at/);
});

test('repeat failures identify isolated missing-app errors as worktree-shaped', () => {
  const ticket = createFixture('repeat worktree-shaped failure fixture');
  for (const number of [1, 2]) {
    const sessionId = `repeat-worktree-failure-${number}-${Date.now()}`;
    const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
    const executor = prepared.ticket.dispatchExecutor;
    const worker = `repeat-worktree-failure-worker-${number}`;
    assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
      sessionId,
      token: prepared.token,
      executor,
      agentName: worker,
    }).ok, true);
    assert.equal(store.bindDispatchAgent(sessionId, executor, `repeat-worktree-failure-agent-${number}`, worker).ok, true);
    assert.equal(store.claimTicket(slug, ticket.ref, worker, {
      sessionId,
      token: prepared.token,
      executor,
    }).ok, true);
    assert.equal(store.recordDispatchAgentFailure(slug, ticket.ref, {
      token: prepared.token,
      executor,
      sessionId,
      taskName: worker,
      agentId: `repeat-worktree-failure-agent-${number}`,
      agentName: worker,
      error: 'Vite returned 404 because the app service is missing.',
    }).ok, true);
    assert.equal(store.releaseTicket(slug, ticket.ref, worker, { status: 'todo', source: 'test' }).ok, true);
  }

  assert.throws(() => store.prepareDispatch(slug, ticket.ref), /isolated no-commit dispatches.*died at.*--shared-tree.*sharedTree:true/);
  const overridden = store.prepareDispatch(slug, ticket.ref, { allowRepeatFailure: true });
  assert.equal(store.releaseTicket(slug, ticket.ref, 'repeat-worktree-failure-cleanup', { status: 'todo', source: 'test', force: true }).ok, true);
  assert.equal(overridden.ticket.dispatch.repeatFailureOverride.priorAttempts, 2);
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
  assert.equal(store.clearSubmission(slug, ticket.ref, { by: 'rework-second-worker', status: 'todo', source: 'test' }).ok, true);

  after = store.getTicket(slug, ticket.ref);
  assert.equal(after.reworkEvents.length, 2);
  assert.equal(after.reworkEvents[1].kind, 'submission_cleared');
  assert.equal(after.reworkEvents[1].attempt.agentId, 'rework-agent-2');
  assert.equal(after.reworkEvents[1].attempt.outcome, 'submitted');
  assert.equal(Object.hasOwn(after.reworkEvents[1], 'submission'), false);
});

test('creation bindings reserve one launched dispatch each within a shared session', () => {
  const sessionId = `creation-allocation-${Date.now()}`;
  const tickets = [createFixture('first creation allocation'), createFixture('second creation allocation')];
  for (const [index, ticket] of tickets.entries()) {
    const dispatch = store.prepareDispatch(slug, ticket.ref, { sessionId });
    assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
      sessionId,
      token: dispatch.token,
      executor: dispatch.ticket.dispatchExecutor,
      agentName: `creation-allocation-${index}`,
    }).ok, true);
  }
  const targets = tickets.map((_, index) => path.join(SIDEQUEST_HOME, 'worktrees', `creation-allocation-${Date.now()}-${index}`));
  const bindings = targets.map((target) => store.bindDispatchWorktreeCreation(slug, sessionId, target));
  assert.equal(bindings.every((binding: any) => binding.ok), true);
  assert.deepEqual(new Set(bindings.map((binding: any) => binding.ref)), new Set(tickets.map((ticket) => ticket.ref)));
  assert.equal(store.bindDispatchWorktreeCreation(slug, sessionId, targets[0]).ref, bindings[0].ref);
  assert.equal(store.bindDispatchWorktreeCreation(slug, sessionId, path.join(SIDEQUEST_HOME, 'worktrees', 'creation-allocation-extra')).reason, 'dispatch_binding_unavailable');
  for (let index = 0; index < tickets.length; index += 1) {
    assert.equal(store.releaseTicket(slug, tickets[index].ref, `creation-allocation-${index}`, { status: 'todo', source: 'test', force: true }).ok, true);
  }
});

test('a prepared sibling cannot supply authority for a launched dispatch checkout', () => {
  const sessionId = `prepared-sibling-${Date.now()}`;
  const preparedTicket = createFixture('prepared sibling isolation fixture');
  const launchedTicket = createFixture('launched sibling isolation fixture');
  store.prepareDispatch(slug, preparedTicket.ref, { sessionId });
  const launched = store.prepareDispatch(slug, launchedTicket.ref, { sessionId });
  const executor = launched.ticket.dispatchExecutor;
  assert.equal(store.recordDispatchLaunch(slug, launchedTicket.ref, {
    sessionId,
    token: launched.token,
    executor,
    agentName: 'launched-sibling',
  }).ok, true);
  const worktree = path.join(SIDEQUEST_HOME, 'worktrees', `launched-sibling-${Date.now()}`);
  try {
    assert.equal(store.bindDispatchWorktreeCreation(slug, sessionId, worktree).ref, launchedTicket.ref);
    const expectation = store.dispatchIsolationExpectation({ sessionId, executor });
    assert.equal(expectation.ref, launchedTicket.ref);
    assert.equal(expectation.expectedWorktree, worktrees.canonicalPath(worktree));
    assert.equal(store.getTicket(slug, preparedTicket.ref).dispatch.outcome, 'prepared');
  } finally {
    assert.equal(store.releaseTicket(slug, preparedTicket.ref, 'prepared-sibling-cleanup', { status: 'todo', source: 'test', force: true }).ok, true);
    assert.equal(store.releaseTicket(slug, launchedTicket.ref, 'launched-sibling-cleanup', { status: 'todo', source: 'test', force: true }).ok, true);
  }
});

test('ordinary isolated dispatches preserve native worktree isolation', () => {
  const ticket = createFixture('ordinary isolation fixture');
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: `ordinary-isolation-${Date.now()}` });
  prepared.ticket.dispatch.integrationTarget = { mode: 'local', branch: 'main' };
  const briefing = agentsync.renderTicketBriefing(prepared.ticket, prepared.token, slug, PROJECT);
  const spawn = agentsync.agentSpawn(
    prepared.ticket.dispatch.launchName,
    agentsync.ticketIsolation(prepared.ticket, prepared.ticket.dispatch.sharedTree),
    null,
    prepared.ticket.dispatchExecutor,
    'Implement the ticket.',
    'ordinary isolation fixture',
  );
  assert.equal(spawn.isolation, 'worktree');
  assert.match(briefing, new RegExp(`git reset --hard ${prepared.ticket.dispatch.baseCommit}`));
  assert.doesNotMatch(briefing, /git rebase --onto/);
  assert.equal(store.releaseTicket(slug, ticket.ref, 'ordinary-isolation-cleanup', { status: 'todo', source: 'test', force: true }).ok, true);
});

test('released handbacks carry registered native worktrees into continuation dispatches', () => {
  const ticket = createFixture('continuation checkpoint fixture');
  const sessionId = `continuation-${Date.now()}`;
  const agentId = `continuation-${Date.now()}`;
  const branch = `worktree-agent-${agentId}`;
  const worktree = worktrees.canonicalPath(path.join(SIDEQUEST_HOME, 'worktrees', `agent-native-parent-${agentId}`, `agent-${agentId}`));
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
  const executor = prepared.ticket.dispatchExecutor;
  try {
    assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
      sessionId,
      token: prepared.token,
      executor,
      agentName: agentId,
    }).ok, true);
    assert.equal(store.bindDispatchWorktreeCreation(slug, sessionId, worktree).ok, true);
    execFileSync('git', ['worktree', 'add', '-b', branch, worktree, 'HEAD'], { cwd: PROJECT });
    markCheckoutInstance(worktree);
    assert.equal(store.completeDispatchWorktreeCreation(slug, sessionId, worktree).ok, true);
    assert.equal(store.bindDispatchAgent(sessionId, executor, agentId, agentId, worktree).ok, true);
    assert.equal(store.getTicket(slug, ticket.ref).dispatch.worktree, worktrees.canonicalPath(worktree));
    assert.equal(store.claimTicket(slug, ticket.ref, 'continuation-worker', {
      sessionId,
      token: prepared.token,
      executor,
    }).ok, true);
    fs.appendFileSync(path.join(worktree, 'tracked.js'), 'module.exports = 2;\n');
    execFileSync('git', ['add', 'tracked.js'], { cwd: worktree });
    execFileSync('git', ['commit', '--quiet', '-m', 'continuation checkpoint'], { cwd: worktree });
    const checkpoint = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim();
    assert.equal(store.releaseTicket(slug, ticket.ref, 'continuation-worker', {
      status: 'todo',
      source: 'test',
      releaseKind: 'handback',
      releaseReason: 'Continue verification in another executor.',
    }).ok, true);
    const releasedDispatch = store.getTicket(slug, ticket.ref).dispatch;
    const releasedAt = releasedDispatch.terminalAt;

    const continued = store.prepareDispatch(slug, ticket.ref, { sessionId: `${sessionId}-next` });
    continued.ticket.dispatch.integrationTarget = { mode: 'local', branch: 'main' };
    const { lease, ...continuation } = continued.ticket.dispatch.continuation;
    assert.deepEqual(continuation, {
      mode: 'retained_worktree_resume',
      ticketRef: ticket.ref,
      sourceWorktree: worktree,
      sourceBranch: branch,
      baseCommit: prepared.ticket.dispatch.baseCommit,
      commit: checkpoint,
      commits: [checkpoint],
      clean: true,
      releasedAt,
      releaseKind: 'handback',
    }, JSON.stringify(continued.ticket.dispatch.continuationFallback));
    assert.equal(lease.dispatchBaseline, prepared.ticket.dispatch.baseCommit);
    assert.equal(lease.observedRevision, checkpoint);
    assert.equal(lease.boundRevision, checkpoint);
    assert.equal(lease.boundGitDirectory, releasedDispatch.worktreeGitDirectory);
    assert.equal(lease.boundCommonGitDirectory, releasedDispatch.worktreeCommonGitDirectory);
    const briefing = agentsync.renderTicketBriefing(continued.ticket, continued.token, slug, PROJECT);
    const spawn = agentsync.agentSpawn(
      continued.ticket.dispatch.launchName,
      agentsync.ticketIsolation(continued.ticket, continued.ticket.dispatch.sharedTree),
      null,
      continued.ticket.dispatchExecutor,
      agentsync.renderDispatchStub(continued.ticket, continued.token, PROJECT),
      'retained continuation fixture',
    );
    assert.equal(Object.hasOwn(spawn, 'isolation'), false);
    // SQ-2183. The contract used to open with an EnterWorktree call that cannot reach a board-retained
    // worktree, so continuations released without doing any work. The retained tree is reachable by
    // absolute path, which is what the contract must say instead.
    assert.doesNotMatch(briefing, /call EnterWorktree with/);
    assert.match(briefing, /do NOT call EnterWorktree/);
    assert.ok(briefing.includes(`git -C ${worktree} rev-parse HEAD\` equals \`${checkpoint}\``));
    assert.match(briefing, new RegExp(`git rebase --onto ${continued.ticket.dispatch.baseCommit} ${continued.ticket.dispatch.continuation.baseCommit}`));
    assert.match(briefing, /If the rebase conflicts, stop and report the conflict/);
    assert.doesNotMatch(briefing, new RegExp(`git reset --hard ${continued.ticket.dispatch.baseCommit}`));
    assert.doesNotMatch(briefing, /git cherry-pick/);
    assert.ok(store.dispatchWarnings(continued.ticket, slug).some((warning?: any) => warning.includes(`at ${checkpoint}`)));

    const continuationExecutor = continued.ticket.dispatchExecutor;
    const continuationAgentId = `${agentId}-next`;
    assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
      sessionId: `${sessionId}-next`,
      token: continued.token,
      executor: continuationExecutor,
      agentName: continuationAgentId,
    }).ok, true);
    assert.equal(store.bindDispatchAgent(`${sessionId}-next`, continuationExecutor, continuationAgentId, continuationAgentId).ok, true);
    assert.equal(store.claimTicket(slug, ticket.ref, 'continuation-second-worker', {
      sessionId: `${sessionId}-next`,
      token: continued.token,
      executor: continuationExecutor,
    }).ok, true);
    assert.equal(store.getTicket(slug, ticket.ref).dispatch.worktree, worktrees.canonicalPath(worktree));
    assert.equal(store.submitTicket(slug, ticket.ref, 'continuation-second-worker', {
      commit: checkpoint,
      worktree,
      source: 'test',
    }).ok, true);
    assert.equal(store.getTicket(slug, ticket.ref).submission.worktree, worktree);
  } finally {
    store.releaseTicket(slug, ticket.ref, 'continuation-cleanup', { status: 'todo', source: 'test', force: true });
    execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: PROJECT });
    execFileSync('git', ['branch', '-D', branch], { cwd: PROJECT });
  }
});

test('continuation refuses a same-path replacement linked checkout', () => {
  const ticket = createFixture('continuation replacement fixture');
  const sessionId = `continuation-replacement-${Date.now()}`;
  const agentId = `continuation-replacement-${Date.now()}`;
  const branch = `worktree-agent-${agentId}`;
  const worktree = worktrees.agentWorktreePath(PROJECT, agentId);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
  const executor = prepared.ticket.dispatchExecutor;
  try {
    assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
      sessionId,
      token: prepared.token,
      executor,
      agentName: agentId,
    }).ok, true);
    assert.equal(store.bindDispatchWorktreeCreation(slug, sessionId, worktree).ok, true);
    execFileSync('git', ['worktree', 'add', '-b', branch, worktree, 'HEAD'], { cwd: PROJECT });
    markCheckoutInstance(worktree);
    assert.equal(store.completeDispatchWorktreeCreation(slug, sessionId, worktree).ok, true);
    assert.equal(store.bindDispatchAgent(sessionId, executor, agentId, agentId, worktree).ok, true);
    assert.equal(store.claimTicket(slug, ticket.ref, 'continuation-replacement-worker', {
      sessionId,
      token: prepared.token,
      executor,
    }).ok, true);
    fs.appendFileSync(path.join(worktree, 'tracked.js'), 'module.exports = 8;\n');
    execFileSync('git', ['add', 'tracked.js'], { cwd: worktree });
    execFileSync('git', ['commit', '--quiet', '-m', 'replacement checkpoint'], { cwd: worktree });
    const checkpoint = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim();
    assert.equal(store.releaseTicket(slug, ticket.ref, 'continuation-replacement-worker', {
      status: 'todo',
      source: 'test',
      releaseKind: 'handback',
    }).ok, true);
    const releasedDispatch = store.getTicket(slug, ticket.ref).dispatch;
    assert.equal(releasedDispatch.terminalWorktreeRevision, checkpoint);
    const boundGitDirectory = worktrees.canonicalPath(releasedDispatch.worktreeGitDirectory);

    execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: PROJECT });
    execFileSync('git', ['worktree', 'add', '--detach', worktree, checkpoint], { cwd: PROJECT });
    const replacementGitDirectory = worktrees.canonicalPath(path.resolve(worktree, execFileSync('git', ['rev-parse', '--git-dir'], {
      cwd: worktree,
      encoding: 'utf8',
    }).trim()));
    assert.equal(replacementGitDirectory, boundGitDirectory);

    const continued = store.prepareDispatch(slug, ticket.ref, { sessionId: `${sessionId}-next` });
    assert.equal(continued.ticket.dispatch.continuation, undefined);
    assert.equal(continued.ticket.dispatch.continuationFallback.reason, 'released_worktree_identity_unavailable');
  } finally {
    store.releaseTicket(slug, ticket.ref, 'continuation-replacement-cleanup', { status: 'todo', source: 'test', force: true });
    if (fs.existsSync(worktree)) execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: PROJECT });
    try { execFileSync('git', ['branch', '-D', branch], { cwd: PROJECT }); } catch (_) {}
  }
});

test('dirty released worktrees without commits resume in place for a continuation', () => {
  const ticket = createFixture('dirty continuation fixture');
  const sessionId = `dirty-continuation-${Date.now()}`;
  const agentId = `dirty-continuation-${Date.now()}`;
  const branch = `worktree-agent-${agentId}`;
  const worktree = worktrees.agentWorktreePath(PROJECT, agentId);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
  const executor = prepared.ticket.dispatchExecutor;
  try {
    assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
      sessionId,
      token: prepared.token,
      executor,
      agentName: agentId,
    }).ok, true);
    assert.equal(store.bindDispatchWorktreeCreation(slug, sessionId, worktree).ok, true);
    execFileSync('git', ['worktree', 'add', '-b', branch, worktree, 'HEAD'], { cwd: PROJECT });
    markCheckoutInstance(worktree);
    assert.equal(store.completeDispatchWorktreeCreation(slug, sessionId, worktree).ok, true);
    assert.equal(store.bindDispatchAgent(sessionId, executor, agentId, agentId, worktree).ok, true);
    assert.equal(store.claimTicket(slug, ticket.ref, 'dirty-continuation-worker', {
      sessionId,
      token: prepared.token,
      executor,
    }).ok, true);
    fs.appendFileSync(path.join(worktree, 'tracked.js'), 'module.exports = 4;\n');
    assert.equal(store.releaseTicket(slug, ticket.ref, 'dirty-continuation-worker', {
      status: 'todo',
      source: 'test',
    }).ok, true);

    // An integration target is what makes the briefing render its worktree-synchronization step, and that
    // step is the one that used to say discard. Without a target here the fixture silently skipped the
    // section entirely, which is how the instruction shipped uncovered (SQ-2180).
    const continued = store.prepareDispatch(slug, ticket.ref, {
      sessionId: `${sessionId}-next`,
      integrationMode: 'local',
      integrationBranch: 'main',
    });
    assert.equal(continued.ticket.dispatch.continuation.mode, 'dirty_worktree_resume');
    const briefing = agentsync.renderTicketBriefing(continued.ticket, continued.token, slug, PROJECT);
    const spawn = agentsync.agentSpawn(
      continued.ticket.dispatch.launchName,
      agentsync.ticketIsolation(continued.ticket, continued.ticket.dispatch.sharedTree),
      null,
      continued.ticket.dispatchExecutor,
      agentsync.renderDispatchStub(continued.ticket, continued.token, PROJECT),
      'dirty continuation fixture',
    );
    assert.equal(Object.hasOwn(spawn, 'isolation'), false);
    assert.match(briefing, /with uncommitted work in retained worktree/);
    // SQ-2183, same unreachable contract on the dirty-resume path, where the retained tree is the only
    // copy of the work, so being unable to enter it stranded the ticket outright.
    assert.doesNotMatch(briefing, /call EnterWorktree with/);
    assert.match(briefing, /do NOT call EnterWorktree/);
    assert.ok(briefing.includes(`git -C ${continued.ticket.dispatch.continuation.sourceWorktree} status --porcelain`));
    assert.match(briefing, /never committed and never stashed, so that worktree is the only copy/);
    assert.doesNotMatch(briefing, /git cherry-pick/);
    // SQ-2180. This continuation exists BECAUSE the tree holds uncommitted work, so the sync step must
    // never hand the executor a discard. One did read that instruction and stopped rather than lose 11
    // files that were committed nowhere and stashed nowhere.
    assert.match(briefing, /this worktree holds uncommitted work retained from the previous attempt/);
    assert.match(briefing, /preserve before moving/);
    assert.match(briefing, /git rebase --onto/);
    assert.match(briefing, /never use `git stash`/);
    assert.match(briefing, /Rebase, never merge/);
    assert.doesNotMatch(briefing, /reset --hard/);
    assert.doesNotMatch(briefing, /git checkout --/);

    const continuationExecutor = continued.ticket.dispatchExecutor;
    const continuationAgentId = `${agentId}-next`;
    assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
      sessionId: `${sessionId}-next`,
      token: continued.token,
      executor: continuationExecutor,
      agentName: continuationAgentId,
    }).ok, true);
    assert.equal(store.bindDispatchAgent(`${sessionId}-next`, continuationExecutor, continuationAgentId, continuationAgentId).ok, true);
    assert.equal(store.claimTicket(slug, ticket.ref, 'dirty-continuation-second-worker', {
      sessionId: `${sessionId}-next`,
      token: continued.token,
      executor: continuationExecutor,
    }).ok, true);
    assert.equal(store.getTicket(slug, ticket.ref).dispatch.worktree, worktrees.canonicalPath(worktree));
    assert.deepEqual(store.completionTreeCheck(slug, store.getTicket(slug, ticket.ref)).changedPaths, ['tracked.js']);
  } finally {
    store.releaseTicket(slug, ticket.ref, 'dirty-continuation-cleanup', { status: 'todo', source: 'test', force: true });
    execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: PROJECT });
    execFileSync('git', ['branch', '-D', branch], { cwd: PROJECT });
  }
});

test('dirty released worktrees with checkpoints fall back to cherry-picking the commit range', () => {
  const ticket = createFixture('dirty checkpoint fallback fixture');
  const sessionId = `dirty-checkpoint-${Date.now()}`;
  const agentId = `dirty-checkpoint-${Date.now()}`;
  const branch = `worktree-agent-${agentId}`;
  const worktree = worktrees.agentWorktreePath(PROJECT, agentId);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
  const executor = prepared.ticket.dispatchExecutor;
  try {
    assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
      sessionId,
      token: prepared.token,
      executor,
      agentName: agentId,
    }).ok, true);
    assert.equal(store.bindDispatchWorktreeCreation(slug, sessionId, worktree).ok, true);
    execFileSync('git', ['worktree', 'add', '-b', branch, worktree, 'HEAD'], { cwd: PROJECT });
    markCheckoutInstance(worktree);
    assert.equal(store.completeDispatchWorktreeCreation(slug, sessionId, worktree).ok, true);
    assert.equal(store.bindDispatchAgent(sessionId, executor, agentId, agentId, worktree).ok, true);
    assert.equal(store.claimTicket(slug, ticket.ref, 'dirty-checkpoint-worker', {
      sessionId,
      token: prepared.token,
      executor,
    }).ok, true);
    fs.appendFileSync(path.join(worktree, 'tracked.js'), 'module.exports = 5;\n');
    execFileSync('git', ['add', 'tracked.js'], { cwd: worktree });
    execFileSync('git', ['commit', '--quiet', '-m', 'dirty continuation checkpoint'], { cwd: worktree });
    const checkpoint = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim();
    fs.appendFileSync(path.join(worktree, 'tracked.js'), 'module.exports = 6;\n');
    assert.equal(store.releaseTicket(slug, ticket.ref, 'dirty-checkpoint-worker', {
      status: 'todo',
      source: 'test',
      releaseKind: 'handback',
      releaseReason: 'Continue from the committed checkpoint.',
    }).ok, true);

    const continued = store.prepareDispatch(slug, ticket.ref, { sessionId: `${sessionId}-next` });
    assert.equal(continued.ticket.dispatch.continuation, undefined);
    assert.deepEqual(continued.ticket.dispatch.continuationFallback.commits, [checkpoint]);
    const briefing = agentsync.renderTicketBriefing(continued.ticket, continued.token, slug, PROJECT);
    assert.match(briefing, new RegExp(`git cherry-pick ${checkpoint}`));
  } finally {
    store.releaseTicket(slug, ticket.ref, 'dirty-checkpoint-cleanup', { status: 'todo', source: 'test', force: true });
    execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: PROJECT });
    execFileSync('git', ['branch', '-D', branch], { cwd: PROJECT });
  }
});

test('released handbacks carry checkpoints through 8.3 project aliases', { skip: process.platform !== 'win32' }, (context: { skip: (reason: string) => void }) => {
  const projectAlias = windowsShortPathAlias(PROJECT);
  if (!projectAlias) {
    context.skip('8.3 aliases are disabled for this filesystem.');
    return;
  }
  const aliasSlug = store.ensureProject(projectAlias).slug;
  const ticket = store.createTicket(aliasSlug, {
    title: '8.3 continuation checkpoint fixture',
    category: 'dispatch.lifecycle',
    files: ['tracked.js'],
    source: 'test',
  });
  const sessionId = `continuation-short-path-${Date.now()}`;
  const agentId = `continuation-short-path-${Date.now()}`;
  const branch = `worktree-agent-${agentId}`;
  const worktree = worktrees.agentWorktreePath(projectAlias, agentId);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  const prepared = store.prepareDispatch(aliasSlug, ticket.ref, { sessionId });
  const executor = prepared.ticket.dispatchExecutor;
  try {
    assert.equal(store.recordDispatchLaunch(aliasSlug, ticket.ref, {
      sessionId,
      token: prepared.token,
      executor,
      agentName: agentId,
    }).ok, true);
    assert.equal(store.bindDispatchWorktreeCreation(aliasSlug, sessionId, worktree).ok, true);
    execFileSync('git', ['worktree', 'add', '-b', branch, worktree, 'HEAD'], { cwd: PROJECT });
    markCheckoutInstance(worktree);
    assert.equal(store.completeDispatchWorktreeCreation(aliasSlug, sessionId, worktree).ok, true);
    assert.equal(store.bindDispatchAgent(sessionId, executor, agentId, agentId, worktree).ok, true);
    assert.equal(store.claimTicket(aliasSlug, ticket.ref, 'continuation-short-path-worker', {
      sessionId,
      token: prepared.token,
      executor,
    }).ok, true);
    fs.appendFileSync(path.join(worktree, 'tracked.js'), 'module.exports = 3;\n');
    execFileSync('git', ['add', 'tracked.js'], { cwd: worktree });
    execFileSync('git', ['commit', '--quiet', '-m', '8.3 continuation checkpoint'], { cwd: worktree });
    const checkpoint = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim();
    assert.equal(store.releaseTicket(aliasSlug, ticket.ref, 'continuation-short-path-worker', {
      status: 'todo',
      source: 'test',
      releaseKind: 'handback',
      releaseReason: 'Continue verification in another executor.',
    }).ok, true);

    const continued = store.prepareDispatch(aliasSlug, ticket.ref, { sessionId: `${sessionId}-next` });
    assert.deepEqual(continued.ticket.dispatch.continuation, {
      mode: 'retained_worktree_resume',
      ticketRef: ticket.ref,
      sourceWorktree: worktree,
      sourceBranch: branch,
      baseCommit: prepared.ticket.dispatch.baseCommit,
      commit: checkpoint,
      commits: [checkpoint],
      clean: true,
      releasedAt: store.getTicket(aliasSlug, ticket.ref).dispatch.terminalAt,
      releaseKind: 'handback',
    });
  } finally {
    store.releaseTicket(aliasSlug, ticket.ref, 'continuation-short-path-cleanup', { status: 'todo', source: 'test', force: true });
    execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: PROJECT });
    execFileSync('git', ['branch', '-D', branch], { cwd: PROJECT });
  }
});

test('reclaiming an unclaimed isolated dispatch preserves its unknown lease', () => {
  const ticket = createFixture('reclaim unclaimed isolated worktree');
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: `reclaim-unclaimed-${Date.now()}` });
  const agentId = `reclaim-unclaimed-agent-${ticket.id}`;
  const worktree = worktrees.agentWorktreePath(PROJECT, agentId);
  const branch = `worktree-agent-${agentId}`;
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  execFileSync('git', ['worktree', 'add', '-b', branch, worktree, prepared.ticket.dispatch.baseCommit], { cwd: PROJECT });
  markCheckoutInstance(worktree);
  try {
    const reclaimed = worktrees.reclaimUnclaimedDispatchWorktree(PROJECT, {
      sharedTree: false,
      worktree,
      baseCommit: prepared.ticket.dispatch.baseCommit,
    });
    assert.equal(reclaimed.reclaimed, false);
    assert.equal(reclaimed.reason, 'lease_refused');
    assert.equal(fs.existsSync(worktree), true);
    assert.equal(execFileSync('git', ['rev-parse', '--verify', branch], { cwd: PROJECT, encoding: 'utf8' }).trim().length > 0, true);
  } finally {
    store.releaseTicket(slug, ticket.ref, 'reclaim-unclaimed-cleanup', { status: 'todo', source: 'test', force: true });
    if (fs.existsSync(worktree)) execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: PROJECT });
    try { execFileSync('git', ['branch', '-D', branch], { cwd: PROJECT }); } catch (_) {}
  }
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

test('a stopped attempt cannot invalidate the next dispatch token', () => {
  const ticket = createFixture('attempt-isolated token recovery fixture');
  const firstSession = `attempt-isolation-first-${Date.now()}`;
  const first = store.prepareDispatch(slug, ticket.ref, { sessionId: firstSession });
  const executor = first.ticket.dispatchExecutor;
  const firstAgent = `attempt-isolation-agent-${ticket.id}`;

  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    sessionId: firstSession,
    token: first.token,
    executor,
    agentName: firstAgent,
  }).ok, true);
  assert.equal(store.bindDispatchAgent(firstSession, executor, firstAgent, firstAgent).ok, true);
  assert.throws(() => store.prepareDispatch(slug, ticket.ref, { sessionId: `attempt-isolation-second-${Date.now()}` }), /live dispatch attempt.*Wait for that executor's terminal hook/);
  assert.equal(store.releaseTicket(slug, ticket.ref, 'first-attempt-worker', { source: 'test' }).reason, 'unclaimed_active_dispatch');

  assert.equal(store.markDispatchStopped(firstSession, executor, firstAgent, firstAgent).stopped, true);
  const stopped = store.getTicket(slug, ticket.ref);
  assert.equal(stopped.dispatch.outcome, 'failed');
  assert.equal(stopped.dispatchNonce, null);

  const second = store.prepareDispatch(slug, ticket.ref, { sessionId: `attempt-isolation-second-${Date.now()}` });
  assert.equal(store.readDispatchBriefing(slug, ticket.ref, second.token).ok, true);
  assert.equal(store.releaseTicket(slug, ticket.ref, 'first-attempt-worker', { source: 'test' }).reason, 'unclaimed_active_dispatch');
  assert.equal(store.readDispatchBriefing(slug, ticket.ref, second.token).ok, true);
  assert.equal(store.releaseTicket(slug, ticket.ref, 'attempt-isolation-cleanup', { status: 'todo', source: 'test', force: true }).ok, true);
});

test('control plane records a hand delivery after recovering the dead unclaimed retry', () => {
  const ticket = createFixture('hand-delivered candidate recovery fixture');
  // The dead attempt has to happen before the submission exists. A claim is refused while a submission is
  // pending (reason `submitted`), so a dispatch prepared after one could never be claimed, and SQ-2117 is why
  // preparation refuses there now.
  const deadSession = `dead-retry-${Date.now()}`;
  const dead = store.prepareDispatch(slug, ticket.ref, { sessionId: deadSession });
  const agentName = `dead-retry-agent-${ticket.id}`;
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    sessionId: deadSession,
    token: dead.token,
    executor: dead.ticket.dispatchExecutor,
    agentName,
  }).ok, true);
  assert.equal(store.bindDispatchAgent(deadSession, dead.ticket.dispatchExecutor, agentName, agentName).ok, true);
  assert.equal(store.releaseTicket(slug, ticket.ref, 'orchestrator', { source: 'test' }).reason, 'unclaimed_active_dispatch');
  assert.equal(store.clearUnclaimedDispatch(slug, ticket.ref, {
    by: 'orchestrator',
    agentName,
    evidence: 'TaskStop reported this exact agent terminal after its claim refusal.',
  }).ok, true);

  const candidate = store.prepareDispatch(slug, ticket.ref, { sessionId: `candidate-${Date.now()}`, allowRepeatFailure: true });
  const owner = `candidate-owner-${ticket.id}`;
  assert.equal(store.claimTicket(slug, ticket.ref, owner, {
    token: candidate.token,
    executor: candidate.ticket.dispatchExecutor,
  }).ok, true);
  commitFixtureChange();
  assert.equal(store.submitTicket(slug, ticket.ref, owner, {
    commit: 'abcdef1234567',
    source: 'test',
  }).ok, true);

  const recordedCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT, encoding: 'utf8' }).trim();
  const closed = store.completeTicketAsControlPlane(slug, ticket.ref, {
    purpose: 'delivery',
    by: 'orchestrator',
    reason: 'Resolved the candidate conflict by hand, then ran the declared gate: 100 pass / 0 fail.',
    deliveryCommit: recordedCommit,
  });
  assert.equal(closed.ok, true);
  assert.equal(closed.ticket.status, 'done');
  assert.equal(closed.ticket.submission.commit, 'abcdef1234567');
  assert.equal(closed.ticket.submission.integration.resultingHead, recordedCommit);
  assert.equal(closed.ticket.completion.delivery.commit, recordedCommit);
});

test('SQ-2117: a pending submission refuses preparation instead of minting an unclaimable attempt', () => {
  const ticket = createFixture('pending submission dispatch refusal fixture');
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: `pending-submission-${Date.now()}` });
  const owner = `pending-submission-owner-${ticket.id}`;
  assert.equal(store.claimTicket(slug, ticket.ref, owner, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);
  commitFixtureChange();
  // Rework preserves the rejected candidate into a quarantine ref, so this one has to be a real commit.
  const candidateCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT, encoding: 'utf8' }).trim();
  assert.equal(store.submitTicket(slug, ticket.ref, owner, { commit: candidateCommit, source: 'test' }).ok, true);
  const submitted = store.getTicket(slug, ticket.ref);

  assert.throws(
    () => store.prepareDispatch(slug, ticket.ref, { sessionId: `pending-submission-retry-${Date.now()}` }),
    new RegExp(`has a pending submission \\(${candidateCommit}\\)[\\s\\S]*sidequest integrate[\\s\\S]*sidequest rework[\\s\\S]*--abandon-submission`),
  );

  // The refusal has to leave the submitted attempt on top, because provenance readers take the agent from the
  // current dispatch and a fresh prepared attempt would name one that never touched the candidate.
  const afterRefusal = store.getTicket(slug, ticket.ref);
  assert.equal(afterRefusal.dispatchNonce, submitted.dispatchNonce, 'a refused preparation mints no new token');
  assert.deepEqual(afterRefusal.dispatch, submitted.dispatch, 'the submitted dispatch projection is untouched');
  assert.equal(afterRefusal.submission.commit, candidateCommit);

  // Rework is the path that dispatches again: it clears the submission first, so the same call then works.
  const reworked = store.reworkSubmission(slug, ticket.ref, {
    by: owner,
    review: 'Reviewer found the candidate needs repair.',
    reason: 'Repair the candidate and resubmit.',
    source: 'test',
  });
  assert.equal(reworked.ok, true, `rework must clear the submission: ${reworked.reason || ''} ${reworked.message || ''}`);
  assert.equal(store.getTicket(slug, ticket.ref).submission, null);
  const replacement = store.prepareDispatch(slug, ticket.ref, { sessionId: `pending-submission-rework-${Date.now()}` });
  assert.equal(replacement.ok, true);
  assert.equal(store.releaseTicket(slug, ticket.ref, 'pending-submission-cleanup', { status: 'todo', source: 'test', force: true }).ok, true);
});

test('claim holders can release routed write scope without submitting first', () => {
  const ticket = createFixture('claim-holder release fixture');
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: `claim-holder-release-${Date.now()}` });
  const owner = `claim-holder-${ticket.id}`;
  assert.equal(store.claimTicket(slug, ticket.ref, owner, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);

  assert.equal(store.releaseTicket(slug, ticket.ref, owner, { status: 'todo', source: 'test' }).ok, true);
  const released = store.getTicket(slug, ticket.ref);
  assert.equal(released.claim, null);
  assert.equal(released.dispatchNonce, null);
});

test('ordinary, resumed, and reworked launches all carry a readable name and the route prefix', () => {
  const ticket = createFixture('Rebuild the release engine safely');
  const sessionId = `launch-name-${Date.now()}`;
  const ordinary = store.prepareDispatch(slug, ticket.ref, { sessionId });
  const executor = ordinary.ticket.dispatchExecutor;
  assert.equal(ordinary.ticket.dispatch.launchName, `${ticket.ref.toLowerCase()}-rebuild-release-engine`);
  assert.equal(ordinary.ticket.dispatch.description, `Claude Sonnet, high · ${ticket.title}`);

  // Re-preparing before anything launched keeps the name: no agent wears it yet.
  const resumed = store.prepareDispatch(slug, ticket.ref, { sessionId });
  assert.notEqual(resumed.token, ordinary.token);
  assert.equal(resumed.ticket.dispatch.launchName, ordinary.ticket.dispatch.launchName);
  assert.equal(resumed.ticket.dispatch.launchSeq, 1);

  // The hook only corrects a launch it can recognise, and recognition is the
  // exact prepared briefing line, so the prompt has to be the prepared stub.
  const prompt = agentsync.renderDispatchStub(resumed.ticket, resumed.ticket.dispatchNonce, PROJECT);
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
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId, allowUnscoped: true });
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

test('the former TeammateIdle payload does not wake a terminal executor', () => {
  const dispatch = finishDispatch('terminal dispatch meeting the former payload');
  assert.equal(runTeammateIdle(dispatch.agentName), null);
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
  const worktree = worktrees.agentWorktreePath(PROJECT, 'a923baseline');
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    sessionId: 'baseline-session',
    agentName: 'baseline-agent',
  }).ok, true);
  assert.equal(store.bindDispatchWorktreeCreation(slug, 'baseline-session', worktree).ok, true);
  assert.equal(store.dispatchWorkspace(slug, store.getTicket(slug, ticket.ref)), null, 'a bound worktree that is not there is not a workspace');
  execFileSync('git', ['worktree', 'add', '--quiet', '-b', 'agent-a923baseline', worktree, 'HEAD'], { cwd: PROJECT });
  markCheckoutInstance(worktree);
  assert.equal(store.bindDispatchAgent('baseline-session', prepared.ticket.dispatchExecutor, 'a923baseline', 'baseline-agent', worktree).ok, true);
  assert.deepEqual(store.dispatchWorkspace(slug, store.getTicket(slug, ticket.ref)), { root: worktrees.canonicalPath(worktree), base: head });

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

test('a dispatch records the configured local integration branch without an override', () => {
  const branch = `configured-target-${Date.now()}`;
  const defaultHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT, encoding: 'utf8' }).trim();
  const targetHead = execFileSync('git', ['commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'configured target base'], { cwd: PROJECT, encoding: 'utf8' }).trim();
  execFileSync('git', ['update-ref', `refs/heads/${branch}`, targetHead], { cwd: PROJECT });
  store.setBoardConfig(slug, { integrationMode: 'local', integrationBranch: branch });
  try {
    const ticket = createFixture('configured local integration target');
    const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: 'configured-target-session' });
    assert.deepEqual(prepared.ticket.dispatch.integrationTarget, {
      mode: 'local',
      upstream: branch,
      branch,
    });
    assert.equal(prepared.ticket.dispatch.baseCommit, targetHead);
    assert.notEqual(prepared.ticket.dispatch.baseCommit, defaultHead);
  } finally {
    store.setBoardConfig(slug, { integrationMode: 'auto', integrationBranch: 'main' });
  }
});

test('worktreeBase local-main records the local main commit while default dispatches keep origin main', () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-dispatch-worktree-base-'));
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-dispatch-worktree-base-remote-'));
  try {
    execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: repository });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repository });
    execFileSync('git', ['config', 'user.name', 'Dispatch Lifecycle Test'], { cwd: repository });
    fs.writeFileSync(path.join(repository, 'tracked.js'), 'module.exports = 1;\n');
    execFileSync('git', ['add', 'tracked.js'], { cwd: repository });
    execFileSync('git', ['commit', '--quiet', '-m', 'remote base'], { cwd: repository });
    execFileSync('git', ['init', '--bare', remote], { windowsHide: true });
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: repository });
    execFileSync('git', ['push', '--quiet', '-u', 'origin', 'main'], { cwd: repository });
    const originMain = execFileSync('git', ['rev-parse', 'origin/main'], { cwd: repository, encoding: 'utf8' }).trim();
    fs.writeFileSync(path.join(repository, 'tracked.js'), 'module.exports = 2;\n');
    execFileSync('git', ['commit', '--quiet', '-am', 'local-only main'], { cwd: repository });
    const localMain = execFileSync('git', ['rev-parse', 'main'], { cwd: repository, encoding: 'utf8' }).trim();
    const baseSlug = store.ensureProject(repository, 'dispatch worktree base').slug;

    const defaultTicket = store.createTicket(baseSlug, { title: 'default worktree base', category: 'dispatch.lifecycle', files: ['tracked.js'] });
    const defaultDispatch = store.prepareDispatch(baseSlug, defaultTicket.ref, { sessionId: 'default-worktree-base' });
    assert.equal(defaultDispatch.ticket.dispatch.baseCommit, originMain);
    assert.deepEqual(defaultDispatch.ticket.dispatch.integrationTarget, { mode: 'remote', upstream: 'origin/main', branch: 'main' });
    assert.deepEqual(defaultDispatch.warnings, ['Local main is 1 commit ahead of origin/main; isolated worktrees fork the local tracking ref. Push first: git push origin main']);
    assert.deepEqual(defaultDispatch.ticket.dispatch.localAheadWarning, {
      count: 1,
      message: 'Local main is 1 commit ahead of origin/main; isolated worktrees fork the local tracking ref. Push first: git push origin main',
    });

    store.setBoardConfig(baseSlug, { worktreeBase: 'local-main' });
    const localTicket = store.createTicket(baseSlug, { title: 'local worktree base', category: 'dispatch.lifecycle', files: ['tracked.js'] });
    const localDispatch = store.prepareDispatch(baseSlug, localTicket.ref, { sessionId: 'local-worktree-base' });
    assert.equal(localDispatch.ticket.dispatch.baseCommit, localMain);
    assert.deepEqual(localDispatch.ticket.dispatch.integrationTarget, { mode: 'local', upstream: 'main', branch: 'main' });
    assert.deepEqual(localDispatch.warnings, ['Local main is 1 commit ahead of origin/main; isolated worktrees fork the local tracking ref. Push first: git push origin main']);
    assert.deepEqual(store.pulsePayload(baseSlug, localTicket.ref).dispatch.localAheadWarning, {
      count: 1,
      message: 'Local main is 1 commit ahead of origin/main; isolated worktrees fork the local tracking ref. Push first: git push origin main',
    });

    execFileSync('git', ['push', '--quiet', 'origin', 'main'], { cwd: repository });
    const syncedTicket = store.createTicket(baseSlug, { title: 'in-sync worktree base', category: 'dispatch.lifecycle', files: ['tracked.js'] });
    const syncedDispatch = store.prepareDispatch(baseSlug, syncedTicket.ref, { sessionId: 'synced-worktree-base' });
    assert.equal(syncedDispatch.warnings, undefined);
    assert.equal(syncedDispatch.ticket.dispatch.localAheadWarning, undefined);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
  }
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

test('a re-dispatch after a handback picks up files declared since the release', () => {
  const sessionId = `released-binding-expansion-${Date.now()}`;
  const ticket = createFixture('released binding unions with expanded scope');
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
  assert.deepEqual(prepared.ticket.dispatch.declaredFiles, ['tracked.js', `.release/unreleased/${ticket.ref}.md`]);
  assert.equal(store.claimTicket(slug, ticket.ref, 'expansion-worker', {
    sessionId,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);
  assert.equal(store.releaseTicket(slug, ticket.ref, 'expansion-worker', {
    status: 'todo',
    source: 'test',
    releaseKind: 'handback',
    releaseReason: 'A stale pin outside the dispatched binding blocks verify.',
  }).ok, true);
  assert.ok(store.getTicket(slug, ticket.ref).dispatch.terminalAt);
  store.updateTicket(slug, ticket.ref, { files: ['tracked.js', 'late-addition.js'] });
  assert.deepEqual(store.getTicket(slug, ticket.ref).files, ['tracked.js', 'late-addition.js']);
  const redispatched = store.prepareDispatch(slug, ticket.ref, { sessionId: `${sessionId}-next` });
  assert.deepEqual(redispatched.ticket.dispatch.declaredFiles.slice().sort(), [`.release/unreleased/${ticket.ref}.md`, 'late-addition.js', 'tracked.js']);
});

test('dispatch token files authenticate the briefing and claim without transcribing a secret', () => {
  const ticket = createFixture('token file dispatch');
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: `token-file-${Date.now()}` });
  const tokenFile = prepared.ticket.dispatch.tokenFile;

  assert.ok(path.isAbsolute(tokenFile));
  assert.equal(fs.readFileSync(tokenFile, 'utf8').trim(), prepared.token);
  assert.equal(store.readDispatchBriefing(slug, ticket.ref, undefined, tokenFile).ok, true);

  // The store seam above went green while the shipped CLI threw "dispatch
  // briefing nonce is required" on every --token-file call: cmdBriefing rendered
  // with its raw --token option instead of the token the store resolved from the
  // file. Only running the executor's actual first command catches that wiring.
  const cliBriefing = spawnSync(process.execPath, [
    path.join(__dirname, '..', 'bin', 'sidequest.js'),
    'briefing', ticket.ref, '--token-file', tokenFile, '--project', PROJECT,
  ], { encoding: 'utf8', env: Object.assign({}, process.env, { SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: PROJECT }) });
  assert.equal(cliBriefing.status, 0, `briefing --token-file must render: ${cliBriefing.stderr}${cliBriefing.stdout}`);
  assert.match(cliBriefing.stdout, new RegExp(ticket.ref));
  assert.equal(store.claimTicket(slug, ticket.ref, 'token-file-worker', {
    tokenFile,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);
  assert.equal(store.readDispatchBriefing(slug, ticket.ref, undefined, `${tokenFile}.missing`).reason, 'token');
});

test('dispatch tokens accept case and separator normalization but reject transposition with recovery guidance', () => {
  const ticket = createFixture('transcription-safe dispatch token');
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: `token-normalization-${Date.now()}` });
  const normalizedToken = prepared.token.replace(/-/g, '').toUpperCase();
  const firstTokenGroup = prepared.token.slice(0, 4);
  const swappedIndex = firstTokenGroup.split('').findIndex((character: string, index: number) => character !== firstTokenGroup[index + 1]);
  assert.notEqual(swappedIndex, -1);
  const transposedToken = `${prepared.token.slice(0, swappedIndex)}${prepared.token[swappedIndex + 1]}${prepared.token[swappedIndex]}${prepared.token.slice(swappedIndex + 2)}`;

  assert.match(prepared.token, /^[abcdefghjkmnpqrstuvwxyz23456789]{4}(?:-[abcdefghjkmnpqrstuvwxyz23456789]{4}){7}$/);
  assert.equal(store.readDispatchBriefing(slug, ticket.ref, normalizedToken).ok, true);
  assert.equal(store.claimTicket(slug, ticket.ref, 'transposed-token-worker', {
    token: transposedToken,
    executor: prepared.ticket.dispatchExecutor,
  }).reason, 'token');
  assert.match(claimRefusalMessage('token', ticket.ref), /transcribed incorrectly/);
  assert.match(claimRefusalMessage('token', ticket.ref), /Re-read the grouped lowercase token/);
});

test('story membership records the current decision-log revision', () => {
  const story = store.createStory(slug, { title: 'Story membership revision' });
  store.appendStoryLogEntry(slug, story.ref, { by: 'orchestrator', entry: 'DECISION: creation baseline' });
  const ticket = store.createTicket(slug, {
    title: 'story membership revision', category: 'dispatch.lifecycle', files: ['tracked.js'], storyId: story.ref, source: 'test',
  });

  assert.equal(ticket.storyLogSeenSeq, 1);
  assert.equal(store.pulsePayload(slug, ticket.ref).warnings, undefined);
});

test('prepared dispatch pins decisions added after story membership', () => {
  const story = store.createStory(slug, { title: 'Prepared story revision' });
  store.appendStoryLogEntry(slug, story.ref, { by: 'orchestrator', entry: 'DECISION: creation baseline' });
  const ticket = store.createTicket(slug, {
    title: 'prepared story revision', category: 'dispatch.lifecycle', files: ['tracked.js'], storyId: story.ref, source: 'test',
  });
  store.appendStoryLogEntry(slug, story.ref, { by: 'orchestrator', entry: 'CONSTRAINT: prepare boundary includes this' });

  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: `story-log-boundary-${Date.now()}` });

  assert.equal(prepared.ticket.dispatch.storyLogRevision, 2);
  assert.equal(prepared.ticket.storyLogSeenSeq, 2);
  assert.equal(store.pulsePayload(slug, ticket.ref).warnings, undefined);
});

test('dispatch briefing includes each pinned decision once and reports later deltas', () => {
  const story = store.createStory(slug, { title: 'Briefed story revision' });
  store.appendStoryLogEntry(slug, story.ref, { by: 'orchestrator', entry: 'DECISION: creation baseline' });
  const ticket = store.createTicket(slug, {
    title: 'briefed story revision', category: 'dispatch.lifecycle', files: ['tracked.js'], storyId: story.ref, source: 'test',
  });
  store.appendStoryLogEntry(slug, story.ref, { by: 'orchestrator', entry: 'CONSTRAINT: prepare boundary includes this' });
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: `story-log-brief-${Date.now()}` });
  store.appendStoryLogEntry(slug, story.ref, { by: 'orchestrator', entry: 'DISCOVERY: post-prepare delta' });

  const briefing = agentsync.renderTicketBriefing(store.getTicket(slug, ticket.ref), prepared.token, slug, PROJECT);
  const warnings = store.pulsePayload(slug, ticket.ref).warnings.join('\n');

  assert.equal((briefing.match(/#1 DECISION \(orchestrator, orchestrator\): creation baseline/g) || []).length, 1);
  assert.equal((briefing.match(/#2 CONSTRAINT \(orchestrator, orchestrator\): prepare boundary includes this/g) || []).length, 1);
  assert.doesNotMatch(briefing, /#3 DISCOVERY \(orchestrator, orchestrator\): post-prepare delta/);
  assert.match(warnings, /decision log gained 1 entry \(#3\) since .* was prepared/);
  assert.doesNotMatch(warnings, /was claimed/);
});

export {};
