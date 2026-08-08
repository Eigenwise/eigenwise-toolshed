import './_temp-cleanup.js';
import './_sidequest-install-fixture.js';
import { assertRepositoryHookRuntime } from './_hook-runtime.js';
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-quota-fallback-home-'));
const PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-quota-fallback-project-'));
const DISCOVERY = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-quota-fallback-catalog-'));
const catalogDir = path.join(DISCOVERY, 'model-gateway');
fs.mkdirSync(catalogDir, { recursive: true });
fs.writeFileSync(path.join(catalogDir, 'catalog.json'), JSON.stringify({
  schemaVersion: 3,
  source: 'model-gateway',
  codexReadiness: {
    ready: true,
    state: 'ready',
    message: 'Codex readiness confirms the local gateway is ready.',
  },
  models: [{
    slug: 'codex-gpt-5-6-sol',
    id: 'claude-gpt-5.6-sol[1m]',
    label: 'GPT-5.6 Sol',
  }, {
    slug: 'codex-gpt-5-6-terra',
    id: 'claude-gpt-5.6-terra[1m]',
    label: 'GPT-5.6 Terra',
  }],
}));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;
process.env.CLAUDE_PROJECT_DIR = PROJECT;
process.env.SIDEQUEST_DISCOVERY_DIRS = DISCOVERY;

const store = require('../lib/store.js');
const mcp = require('../lib/mcp.js');
const { makeMcpCaller } = require('./_helpers.js');
const { callTool } = makeMcpCaller(mcp);
const slug = store.ensureProject(PROJECT).slug;
const BIN = path.join(__dirname, '..', 'bin', 'sidequest.js');
const FORCE_BYPASS = path.join(__dirname, '..', 'hooks', 'force-exec-bypass.js');
const QUOTA_FALLBACK = path.join(__dirname, '..', 'hooks', 'quota-fallback.js');

store.setCategory({
  id: 'quota.fixture',
  name: 'Quota fixture',
  description: 'Bounded launch-time quota recovery fixture.',
  route: { model: 'fable', effort: 'xhigh' },
  fallback: { model: 'codex-gpt-5-6-sol', effort: 'max' },
  contract: 'Use the prepared route and claim token.',
  enabled: true,
});

function createFixture(title?: any) {
  return store.createTicket(slug, {
    title,
    description: 'Where: quota fallback fixture. Contract: adopt the prepared fallback route after quota failure. Verify: inspect the replacement dispatch result.',
    category: 'quota.fixture',
    source: 'test',
  });
}

function dispatchPrompt(ticket?: any, token?: any) {
  return [
    `Ref: ${ticket.ref}`,
    `Claim this ticket with \`--token ${token}\`.`,
    `--project "${PROJECT}"`,
  ].join('\n');
}

function runHook(script?: any, payload?: any) {
  assertRepositoryHookRuntime();
  const output = execFileSync(process.execPath, [script], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: PROJECT, SIDEQUEST_DISCOVERY_DIRS: DISCOVERY },
  });
  return output.trim() ? JSON.parse(output) : null;
}

function launch(ticket?: any, sessionId?: any) {
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
  const preTool = runHook(FORCE_BYPASS, {
    session_id: sessionId,
    cwd: PROJECT,
    tool_name: 'Agent',
    tool_input: {
      subagent_type: prepared.ticket.dispatchExecutor,
      model: 'fable',
      name: `quota-${ticket.ref.toLowerCase()}`,
      description: prepared.ticket.dispatch.description,
      prompt: dispatchPrompt(ticket, prepared.token),
    },
  });
  assert.equal(store.getTicket(slug, ticket.ref).dispatch.outcome, 'launched');
  return { prepared, toolInput: preTool.hookSpecificOutput.updatedInput };
}

test('known Fable quota failure prepares the exact category fallback and preserves claim truth', async () => {
  const ticket = createFixture('store quota recovery');
  const launched = launch(ticket, 'quota-store-primary');

  const generic = store.recoverDispatchQuotaFailure(slug, ticket.ref, {
    token: launched.prepared.token,
    executor: launched.prepared.ticket.dispatchExecutor,
    error: 'Agent launch failed: permission denied',
  });
  assert.deepEqual(generic, { ok: false, reason: 'unrecognized_failure' });
  assert.equal(store.getTicket(slug, ticket.ref).dispatchNonce, launched.prepared.token);

  const recovered = store.recoverDispatchQuotaFailure(slug, ticket.ref, {
    token: launched.prepared.token,
    executor: launched.prepared.ticket.dispatchExecutor,
    sessionId: 'quota-store-primary',
    error: "Agent launch failed: You've reached your Fable 5 limit",
  });
  assert.equal(recovered.ok, true);
  assert.notEqual(recovered.token, launched.prepared.token);
  assert.deepEqual(recovered.recovery, {
    kind: 'claude_quota_exhausted',
    failedModel: 'fable',
    failedEffort: 'xhigh',
    fallbackSource: 'category fallback',
    model: 'codex-gpt-5-6-sol',
    effort: 'max',
    signature: "You've reached your Fable 5 limit",
    at: recovered.recovery.at,
  });

  let current = store.getTicket(slug, ticket.ref);
  assert.equal(current.model, 'codex-gpt-5-6-sol');
  assert.equal(current.effort, 'max');
  assert.equal(current.exec.backend, 'codex');
  // The replacement launch advertises the model that will actually run, and its
  // name counts past the attempt that burned the quota.
  assert.equal(current.dispatch.description, `GPT-5.6 Sol, max · ${ticket.title}`);
  assert.equal(current.dispatch.launchName, `${ticket.ref.toLowerCase()}-store-quota-recovery-2`);
  assert.deepEqual(current.category.route, { model: 'fable', effort: 'xhigh' });
  assert.deepEqual(current.category.fallback, { model: 'codex-gpt-5-6-sol', effort: 'max' });
  const pulse = store.pulsePayload(slug, ticket.ref);
  assert.deepEqual(pulse.dispatch.route, { model: 'codex-gpt-5-6-sol', effort: 'max' });
  assert.equal(current.dispatch.route.marker, 'gpt-5.6-sol');
  assert.equal(pulse.dispatch.attempts.length, 1);
  assert.equal(pulse.dispatch.attempts[0].outcome, 'quota_exhausted');
  assert.equal(pulse.dispatch.attempts[0].failure.signature, "You've reached your Fable 5 limit");

  const adopted = store.prepareDispatch(slug, ticket.ref, { sessionId: 'quota-store-adopted' });
  assert.equal(adopted.reused, true);
  assert.equal(adopted.token, recovered.token);
  assert.equal(store.getTicket(slug, ticket.ref).dispatch.sessionId, 'quota-store-adopted');
  assert.deepEqual(store.getTicket(slug, ticket.ref).dispatch.preparedBy, { sessionId: 'quota-store-primary', surface: 'store' });
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    sessionId: 'quota-store-adopted',
    token: adopted.token,
    executor: adopted.ticket.dispatchExecutor,
    agentName: 'quota-store-worker',
  }).ok, true);
  assert.equal(store.bindDispatchAgent('quota-store-adopted', adopted.ticket.dispatchExecutor, 'quota-store-agent', 'quota-store-worker').ok, true);

  const wrongEffort = await callTool('claim', {
    project: PROJECT,
    ref: ticket.ref,
    by: 'quota-store-worker',
    token: adopted.token,
    executor: adopted.ticket.dispatchExecutor,
    effort: 'xhigh',
  });
  assert.equal(wrongEffort.ok, false);
  assert.equal(wrongEffort.reason, 'effort_mismatch');
  const claimed = await callTool('claim', {
    project: PROJECT,
    ref: ticket.ref,
    by: 'quota-store-worker',
    token: adopted.token,
    executor: adopted.ticket.dispatchExecutor,
    effort: 'max',
  });
  assert.equal(claimed.ok, true);
  current = store.getTicket(slug, ticket.ref);
  assert.equal(current.model, 'codex-gpt-5-6-sol');
  assert.equal(current.effort, 'max');

  assert.equal(store.releaseTicket(slug, ticket.ref, 'quota-store-worker', { status: 'todo', source: 'test' }).ok, true);
  current = store.getTicket(slug, ticket.ref);
  assert.equal(current.model, 'fable');
  assert.equal(current.effort, 'xhigh');
  assert.deepEqual(store.getCategory('quota.fixture').route, { model: 'fable', effort: 'xhigh' });
});

test('quota recovery cannot prepare a ticket parked before launch', () => {
  const ticket = createFixture('parked quota recovery');
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: 'parked-quota-session' });
  assert.equal(store.releaseTicket(slug, ticket.ref, undefined, { status: 'todo', source: 'orchestrator' }).ok, true);

  const parked = store.getTicket(slug, ticket.ref);
  const recovered = store.recoverDispatchQuotaFailure(slug, ticket.ref, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    error: "Agent launch failed: You've reached your Fable 5 limit",
  });

  assert.deepEqual(recovered, { ok: false, reason: 'not_prepared' });
  const current = store.getTicket(slug, ticket.ref);
  assert.equal(current.status, 'todo');
  assert.equal(current.dispatchNonce, null);
  assert.equal(current.dispatch.outcome, parked.dispatch.outcome);
  assert.equal(current.dispatch.terminalAt, parked.dispatch.terminalAt);
});

test('PostToolUseFailure ignores generic errors and prepares quota fallback for CLI --session and MCP runtime-session adoption', async () => {
  const ticket = createFixture('hook quota recovery');
  const launched = launch(ticket, 'quota-hook-primary');
  const payload = {
    session_id: 'quota-hook-primary',
    cwd: PROJECT,
    tool_name: 'Agent',
    tool_input: launched.toolInput,
  };

  assert.equal(runHook(QUOTA_FALLBACK, { ...payload, error: 'Agent launch failed: network unavailable' }), null);
  assert.equal(store.getTicket(slug, ticket.ref).dispatchNonce, launched.prepared.token);

  const hookOutput = runHook(QUOTA_FALLBACK, {
    ...payload,
    error: "Agent launch failed before start: You've reached your Fable 5 limit",
  });
  assert.equal(hookOutput.hookSpecificOutput.hookEventName, 'PostToolUseFailure');
  assert.match(hookOutput.systemMessage, /configured fallback dispatch/);
  assert.match(hookOutput.systemMessage, new RegExp(ticket.ref));

  const cli = spawnSync(process.execPath, [BIN, 'dispatch', ticket.ref, '--project', PROJECT, '--session', 'quota-cli-adopted', '--unverified-transport', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: PROJECT, SIDEQUEST_DISCOVERY_DIRS: DISCOVERY },
  });
  assert.equal(cli.status, 0, `${cli.stderr}${cli.stdout}`);
  const cliDispatch = JSON.parse(cli.stdout);
  assert.equal(cliDispatch.recovery.failedModel, 'fable');
  assert.equal(cliDispatch.effort, 'max');
  assert.equal(cliDispatch.exec.backend, 'codex');
  assert.match(cliDispatch.spawn.prompt, /\[sidequest-route model=gpt-5\.6-sol effort=max\]/);
  assert.equal(store.getTicket(slug, ticket.ref).dispatch.sessionId, 'quota-cli-adopted');

  const mcpRuntimeSessionId = 'quota-mcp-runtime-session';
  const previousMcpRuntimeSessionId = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = mcpRuntimeSessionId;
  try {
    const mcpDispatch = await callTool('dispatch', {
      project: PROJECT,
      ref: ticket.ref,
      full: true,
    });
    assert.equal(mcpDispatch.token, cliDispatch.token);
    assert.equal(mcpDispatch.recovery.model, 'codex-gpt-5-6-sol');
    assert.equal(mcpDispatch.spawn.subagent_type, 'sidequest-exec-dispatch');
    assert.equal(store.getTicket(slug, ticket.ref).dispatch.sessionId, mcpRuntimeSessionId);
  } finally {
    if (previousMcpRuntimeSessionId == null) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = previousMcpRuntimeSessionId;
  }

  const hooks = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hooks', 'hooks.json'), 'utf8'));
  assert.equal(hooks.hooks.PostToolUseFailure[0].matcher, 'Agent');
  assert.match(hooks.hooks.PostToolUseFailure[0].hooks[0].command, /quota-fallback\.js/);
});

test('PostToolUseFailure records observed terminal executor failures without releasing transient errors', () => {
  const transient = createFixture('transient Agent failure');
  const transientLaunch = launch(transient, 'transient-agent-failure');
  assert.equal(store.claimTicket(slug, transient.ref, 'transient-worker', {
    token: transientLaunch.prepared.token,
    executor: transientLaunch.prepared.ticket.dispatchExecutor,
  }).ok, true);
  assert.equal(runHook(QUOTA_FALLBACK, {
    session_id: 'transient-agent-failure',
    cwd: PROJECT,
    tool_name: 'Agent',
    tool_input: transientLaunch.toolInput,
    error: 'Agent request timed out while the connection was unavailable',
  }), null);
  assert.equal(store.getTicket(slug, transient.ref).dispatch.outcome, 'claimed');
  assert.equal(store.pulsePayload(slug, transient.ref).claim.reclaimable, null);

  const terminal = createFixture('terminal Agent failure');
  const terminalLaunch = launch(terminal, 'terminal-agent-failure');
  assert.equal(store.claimTicket(slug, terminal.ref, 'terminal-worker', {
    token: terminalLaunch.prepared.token,
    executor: terminalLaunch.prepared.ticket.dispatchExecutor,
  }).ok, true);
  const output = runHook(QUOTA_FALLBACK, {
    session_id: 'terminal-agent-failure',
    cwd: PROJECT,
    tool_name: 'Agent',
    tool_input: terminalLaunch.toolInput,
    error: 'Prompt is too long',
  });
  const current = store.getTicket(slug, terminal.ref);
  assert.match(output.systemMessage, /observed terminal failure/);
  assert.equal(current.dispatch.outcome, 'died');
  assert.equal(current.dispatch.failureShape, 'context_overflow');
  assert.equal(current.dispatch.terminalSource, 'agent-terminal-failure');
  assert.equal(store.pulsePayload(slug, terminal.ref).claim.reclaimable, 'observed_stop');
});

test('every seeded Opus category recovers to its explicit Codex fallback without replacing local overrides', () => {
  const expected = new Map([
    ['debugging', {
      route: { model: 'opus', effort: 'high' },
      fallback: { model: 'codex-gpt-5-6-terra', effort: 'high' },
    }],
    ['coding.hard', {
      route: { model: 'opus', effort: 'xhigh' },
      fallback: { model: 'codex-gpt-5-6-sol', effort: 'xhigh' },
    }],
    ['spike-investigation', {
      route: { model: 'opus', effort: 'high' },
      fallback: { model: 'codex-gpt-5-6-sol', effort: 'high' },
    }],
    ['visual-evaluation', {
      route: { model: 'opus', effort: 'medium' },
      fallback: { model: 'codex-gpt-5-6-terra', effort: 'medium' },
    }],
  ]);

  for (const [categoryId, { route, fallback }] of expected) {
    const category = store.getCategory(categoryId, { project: slug });
    assert.deepEqual(category.route, route);
    assert.deepEqual(category.fallback, fallback);

    const ticket = store.createTicket(slug, {
      title: `${categoryId} Opus recovery`,
      description: 'Where: seeded Opus fallback. Contract: recover only from recognized Claude exhaustion. Verify: inspect the replacement route.',
      category: categoryId,
      source: 'test',
    });
    const launched = launch(ticket, `quota-${categoryId}`);
    assert.deepEqual(launched.prepared.ticket.dispatch.route, route);
    const error = categoryId === 'visual-evaluation'
      ? 'Agent launch failed: Your Claude Code subscription does not include access to Opus 5'
      : "Agent launch failed: You've reached your Opus 5 limit";
    const recovered = store.recoverDispatchQuotaFailure(slug, ticket.ref, {
      token: launched.prepared.token,
      executor: launched.prepared.ticket.dispatchExecutor,
      error,
    });

    assert.equal(recovered.ok, true);
    assert.deepEqual(recovered.recovery, {
      kind: 'claude_quota_exhausted',
      failedModel: 'opus',
      failedEffort: route.effort,
      fallbackSource: 'category fallback',
      model: fallback.model,
      effort: fallback.effort,
      signature: error.slice('Agent launch failed: '.length),
      at: recovered.recovery.at,
    });
    const dispatchRoute = store.getTicket(slug, ticket.ref).dispatch.route;
    assert.equal(dispatchRoute.model, fallback.model);
    assert.equal(dispatchRoute.effort, fallback.effort);
    assert.equal(store.releaseTicket(slug, ticket.ref, undefined, { status: 'todo', source: 'test' }).ok, true);
  }

  store.setProjectCategory(slug, 'debugging', 'OVERRIDE', {
    route: { model: 'sonnet', effort: 'medium' },
    fallback: { model: 'codex-gpt-5-6-sol', effort: 'medium' },
  });
  const overridden = store.getCategory('debugging', { project: slug });
  assert.deepEqual(overridden.route, { model: 'sonnet', effort: 'medium' });
  assert.deepEqual(overridden.fallback, { model: 'codex-gpt-5-6-sol', effort: 'medium' });
  assert.equal(store.claudeQuotaFailure('Agent launch failed: network unavailable'), null);
});

test('dispatch failures have closed shapes and terminal attempts stay bounded', () => {
  assert.equal(store.classifyDispatchFailure('Prompt is too long'), 'context_overflow');
  assert.equal(store.classifyDispatchFailure('Agent stopped after max_tokens'), 'max_tokens');
  assert.equal(store.classifyDispatchFailure('Subagent terminated unexpectedly'), 'agent_terminal');
  assert.equal(store.classifyDispatchFailure('Vite returned 404 because the app service is missing.'), 'worktree_environment');
  assert.equal(store.classifyDispatchFailure('Request too large (max 32MB)'), 'context_overflow');
  assert.equal(store.classifyDispatchFailure('gateway not serving'), 'provider_unavailable');
  assert.equal(store.classifyDispatchFailure('not authenticated'), 'auth_failure');
  assert.equal(store.classifyDispatchFailure("You've reached your Fable 5 limit"), 'quota_exhausted');
  assert.equal(store.classifyDispatchFailure(), 'process_death');
  assert.equal(store.classifyDispatchFailure('unexpected launch failure'), 'unknown');

  const released = createFixture('released attempt');
  const preparedRelease = store.prepareDispatch(slug, released.ref, { sessionId: 'released-attempt' });
  assert.equal(store.claimTicket(slug, released.ref, 'released-worker', {
    token: preparedRelease.token,
    executor: preparedRelease.ticket.dispatchExecutor,
  }).ok, true);
  assert.equal(store.releaseTicket(slug, released.ref, 'released-worker', { status: 'todo', source: 'test' }).ok, true);
  assert.equal(store.getTicket(slug, released.ref).dispatch.attempts.at(-1).failureShape, 'unknown');

  const submitted = createFixture('submitted attempt');
  const preparedSubmission = store.prepareDispatch(slug, submitted.ref, { sessionId: 'submitted-attempt' });
  assert.equal(store.claimTicket(slug, submitted.ref, 'submitted-worker', {
    token: preparedSubmission.token,
    executor: preparedSubmission.ticket.dispatchExecutor,
  }).ok, true);
  assert.equal(store.submitTicket(slug, submitted.ref, 'submitted-worker', { commit: 'abc1234def5678', source: 'test' }).ok, true);
  assert.equal(store.getTicket(slug, submitted.ref).dispatch.attempts.at(-1).failureShape, 'unknown');

  const stopped = createFixture('stopped attempt');
  const preparedStopped = store.prepareDispatch(slug, stopped.ref, { sessionId: 'stopped-attempt' });
  assert.equal(store.recordDispatchLaunch(slug, stopped.ref, {
    sessionId: 'stopped-attempt',
    token: preparedStopped.token,
    executor: preparedStopped.ticket.dispatchExecutor,
  }).ok, true);
  assert.equal(store.recordDispatchAgentFailure(slug, stopped.ref, {
    token: preparedStopped.token,
    executor: preparedStopped.ticket.dispatchExecutor,
    error: 'Subagent terminated unexpectedly',
  }).ok, true);
  assert.equal(store.getTicket(slug, stopped.ref).dispatch.failureShape, 'agent_terminal');

  const reconciled = createFixture('reconciled attempt');
  const preparedReconciled = store.prepareDispatch(slug, reconciled.ref, { sessionId: 'reconciled-attempt' });
  assert.equal(store.recordDispatchLaunch(slug, reconciled.ref, {
    sessionId: 'reconciled-attempt',
    token: preparedReconciled.token,
    executor: preparedReconciled.ticket.dispatchExecutor,
  }).ok, true);
  assert.deepEqual(store.reconcileLaunchedDispatches('reconciled-attempt', { source: 'test' }).reconciled, [reconciled.ref]);
  const pulse = store.pulsePayload(slug, reconciled.ref);
  assert.equal(pulse.dispatch.failureShape, 'process_death');
  assert.equal(pulse.dispatch.attempts.at(-1).outcome, 'failed');

  let bounded = createFixture('bounded attempts');
  for (let index = 0; index < 9; index++) {
    const prepared = store.prepareDispatch(slug, bounded.ref, { sessionId: `bounded-attempt-${index}`, allowRepeatFailure: true });
    assert.equal(store.recordDispatchLaunch(slug, bounded.ref, {
      sessionId: `bounded-attempt-${index}`,
      token: prepared.token,
      executor: prepared.ticket.dispatchExecutor,
    }).ok, true);
    assert.equal(store.recordDispatchAgentFailure(slug, bounded.ref, {
      token: prepared.token,
      executor: prepared.ticket.dispatchExecutor,
      error: 'Subagent terminated unexpectedly',
    }).ok, true);
  }
  assert.equal(store.getTicket(slug, bounded.ref).dispatch.attempts.length, 8);
});
