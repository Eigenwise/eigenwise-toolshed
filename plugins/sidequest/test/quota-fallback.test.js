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
const catalogDir = path.join(DISCOVERY, 'codex-gateway');
fs.mkdirSync(catalogDir, { recursive: true });
fs.writeFileSync(path.join(catalogDir, 'catalog.json'), JSON.stringify({
  schemaVersion: 3,
  source: 'codex-gateway',
  models: [{
    slug: 'codex-gpt-5-6-sol',
    id: 'claude-codex-gpt-5.6-sol[1m]',
    label: 'GPT-5.6 Sol',
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

function createFixture(title) {
  return store.createTicket(slug, { title, category: 'quota.fixture', source: 'test' });
}

function dispatchPrompt(ticket, token) {
  return [
    `Ref: ${ticket.ref}`,
    `Claim this ticket with \`--token ${token}\`.`,
    `--project "${PROJECT}"`,
  ].join('\n');
}

function runHook(script, payload) {
  const output = execFileSync(process.execPath, [script], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: PROJECT, SIDEQUEST_DISCOVERY_DIRS: DISCOVERY },
  });
  return output.trim() ? JSON.parse(output) : null;
}

function launch(ticket, sessionId) {
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
  const preTool = runHook(FORCE_BYPASS, {
    session_id: sessionId,
    cwd: PROJECT,
    tool_name: 'Agent',
    tool_input: {
      subagent_type: prepared.ticket.dispatchExecutor,
      model: 'fable',
      name: `quota-${ticket.ref.toLowerCase()}`,
      prompt: dispatchPrompt(ticket, prepared.token),
    },
  });
  assert.equal(store.getTicket(slug, ticket.ref).dispatch.outcome, 'launched');
  return { prepared, toolInput: preTool.hookSpecificOutput.updatedInput };
}

test('known Fable quota failure prepares the exact category fallback and preserves claim truth', () => {
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
  assert.deepEqual(current.category.route, { model: 'fable', effort: 'xhigh' });
  assert.deepEqual(current.category.fallback, { model: 'codex-gpt-5-6-sol', effort: 'max' });
  const pulse = store.pulsePayload(slug, ticket.ref);
  assert.deepEqual(pulse.dispatch.route, { model: 'codex-gpt-5-6-sol', effort: 'max' });
  assert.equal(pulse.dispatch.attempts.length, 1);
  assert.equal(pulse.dispatch.attempts[0].outcome, 'quota_exhausted');
  assert.equal(pulse.dispatch.attempts[0].failure.signature, "You've reached your Fable 5 limit");

  const adopted = store.prepareDispatch(slug, ticket.ref, { sessionId: 'quota-store-adopted' });
  assert.equal(adopted.reused, true);
  assert.equal(adopted.token, recovered.token);
  assert.equal(store.getTicket(slug, ticket.ref).dispatch.sessionId, 'quota-store-adopted');

  const wrongEffort = callTool('claim', {
    project: PROJECT,
    ref: ticket.ref,
    by: 'quota-store-worker',
    token: adopted.token,
    executor: adopted.ticket.dispatchExecutor,
    effort: 'xhigh',
  });
  assert.equal(wrongEffort.ok, false);
  assert.equal(wrongEffort.reason, 'effort_mismatch');
  const claimed = callTool('claim', {
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

test('PostToolUseFailure ignores generic errors and prepares quota fallback for CLI and MCP adoption', () => {
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
  assert.match(hookOutput.hookSpecificOutput.additionalContext, /configured fallback dispatch/);
  assert.match(hookOutput.hookSpecificOutput.additionalContext, new RegExp(ticket.ref));

  const cli = spawnSync(process.execPath, [BIN, 'dispatch', ticket.ref, '--project', PROJECT, '--session', 'quota-cli-adopted', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: PROJECT, SIDEQUEST_DISCOVERY_DIRS: DISCOVERY },
  });
  assert.equal(cli.status, 0, `${cli.stderr}${cli.stdout}`);
  const cliDispatch = JSON.parse(cli.stdout);
  assert.equal(cliDispatch.recovery.failedModel, 'fable');
  assert.equal(cliDispatch.effort, 'max');
  assert.equal(cliDispatch.exec.backend, 'codex');
  assert.match(cliDispatch.briefing, /\[sidequest-route model=gpt-5\.6-sol effort=max\]/);

  const mcpDispatch = callTool('dispatch', {
    project: PROJECT,
    ref: ticket.ref,
    session: 'quota-mcp-adopted',
  });
  assert.equal(mcpDispatch.token, cliDispatch.token);
  assert.equal(mcpDispatch.recovery.model, 'codex-gpt-5-6-sol');
  assert.equal(mcpDispatch.spawn.subagent_type, 'sidequest-exec-dispatch-max');
  assert.equal(store.getTicket(slug, ticket.ref).dispatch.sessionId, 'quota-mcp-adopted');

  const hooks = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hooks', 'hooks.json'), 'utf8'));
  assert.equal(hooks.hooks.PostToolUseFailure[0].matcher, 'Agent');
  assert.match(hooks.hooks.PostToolUseFailure[0].hooks[0].command, /quota-fallback\.js/);
});
