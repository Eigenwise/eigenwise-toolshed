'use strict';
/**
 * Tests for the MCP tool layer (SQ-152): the JSON-RPC handler in lib/mcp.js and
 * the stdio server in bin/sidequest-mcp.js.
 *
 * Two levels:
 *   - handleRequest() unit tests (fast, in-process) for the protocol handshake
 *     and the tool round-trips over the same store the CLI uses.
 *   - one child_process integration test that drives the real stdio server with
 *     newline-delimited JSON-RPC, to prove the transport frames correctly.
 *
 * Run: node --test plugins/sidequest/test/mcp.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawnSync, execFileSync } = require('child_process');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-test-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;
const PROJ = path.join(os.tmpdir(), 'sq-mcp-fixtures', 'board');
process.env.CLAUDE_PROJECT_DIR = PROJ;
const MCP_SESSION_ID = `mcp-test-session-${process.pid}`;
process.env.CLAUDE_CODE_SESSION_ID = MCP_SESSION_ID;
// Start with no discovery root at all — a real machine (e.g. this one, with
// codex-gateway installed) can have a genuine ~/.claude/codex-gateway/catalog.json,
// which would otherwise leak real discovered slugs into these tests. The
// SQ-162 tests below point SIDEQUEST_DISCOVERY_DIRS at their own fake catalog.
const NO_CATALOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-nocatalog-'));
process.env.SIDEQUEST_DISCOVERY_DIRS = NO_CATALOG_DIR;

const mcp = require('../lib/mcp.js');
const agentsync = require('../lib/agentsync.js');
const store = require('../lib/store.js');
const DISPATCH_DESCRIPTION = 'Where: the routed test fixture. Contract: prepare a stable executor without changing the ticket title. Verify: inspect the dispatch result.';

// Write a fake codex-gateway catalog (mirrors test/discovery.test.js) so a
// discovered+enabled custom slug can be exercised over the MCP surface.
function writeCatalogRaw(dir, body) {
  fs.mkdirSync(path.join(dir, 'codex-gateway'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'codex-gateway', 'catalog.json'), body);
}
function seedCatalog(models) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-catalog-'));
  writeCatalogRaw(dir, JSON.stringify({ schemaVersion: 3, source: 'codex-gateway', updatedAt: new Date().toISOString(), models }));
  process.env.SIDEQUEST_DISCOVERY_DIRS = dir;
  return dir;
}
function clearCatalog() {
  process.env.SIDEQUEST_DISCOVERY_DIRS = NO_CATALOG_DIR;
}

// Call a tool through the JSON-RPC surface and return the parsed result object
// (the text content decoded back to JSON), asserting it wasn't an error.
let idc = 0;
function callTool(name, args) {
  const resp = mcp.handleRequest({ jsonrpc: '2.0', id: ++idc, method: 'tools/call', params: { name, arguments: args || {} } });
  assert.ok(resp && resp.result, `tool ${name} returned a result`);
  assert.ok(!resp.result.isError, `tool ${name} errored: ${resp.result.content && resp.result.content[0] && resp.result.content[0].text}`);
  return JSON.parse(resp.result.content[0].text);
}
function callToolRaw(name, args) {
  const resp = mcp.handleRequest({ jsonrpc: '2.0', id: ++idc, method: 'tools/call', params: { name, arguments: args || {} } });
  return resp.result;
}
function callToolOn(server, name, args) {
  const resp = server.handleRequest({ jsonrpc: '2.0', id: ++idc, method: 'tools/call', params: { name, arguments: args || {} } });
  assert.ok(resp && resp.result, `tool ${name} returned a result`);
  assert.ok(!resp.result.isError, `tool ${name} errored: ${resp.result.content && resp.result.content[0] && resp.result.content[0].text}`);
  return JSON.parse(resp.result.content[0].text);
}
function freshMcpServer() {
  const modulePath = require.resolve('../lib/mcp.js');
  delete require.cache[modulePath];
  return require(modulePath);
}
// Legacy native-agent helpers remain CLI-only, but their handlers still have
// direct coverage for the backward-compatible fallback path.
function callHandler(name, args) {
  const tool = mcp.TOOLS.find((t) => t.name === name);
  assert.ok(tool, `tool ${name} exists in the registry`);
  return tool.handler(args || {});
}

function gitAt(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function runCli(args) {
  const cli = path.join(__dirname, '..', 'bin', 'sidequest.js');
  const output = execFileSync(process.execPath, [cli, ...args], {
    encoding: 'utf8', windowsHide: true,
    env: Object.assign({}, process.env, { SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: PROJ }),
  });
  const trimmed = output.trim();
  return trimmed && trimmed.startsWith('{') ? JSON.parse(trimmed) : trimmed;
}

function runForceBypass(payload) {
  const hook = path.join(__dirname, '..', 'hooks', 'force-exec-bypass.js');
  const output = execFileSync(process.execPath, [hook], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: PROJ, CLAUDE_PLUGIN_ROOT: path.join(__dirname, '..') },
  });
  return output.trim() ? JSON.parse(output) : null;
}

function createGitWorktree() {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'sq mcp worktree-'));
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-remote-'));
  gitAt(worktree, ['init']);
  gitAt(worktree, ['config', 'user.name', 'Sidequest Test']);
  gitAt(worktree, ['config', 'user.email', 'sidequest-test@example.invalid']);
  fs.writeFileSync(path.join(worktree, 'README.md'), 'base\n');
  gitAt(worktree, ['add', 'README.md']);
  gitAt(worktree, ['commit', '-m', 'base']);
  gitAt(worktree, ['branch', '-M', 'main']);
  execFileSync('git', ['init', '--bare', remote], { encoding: 'utf8', windowsHide: true });
  gitAt(worktree, ['remote', 'add', 'origin', remote]);
  gitAt(worktree, ['push', '-u', 'origin', 'main']);
  return worktree;
}

test('initialize returns a protocol version, tools capability, and serverInfo', () => {
  const resp = mcp.handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.strictEqual(resp.result.protocolVersion, '2025-06-18', 'echoes the client-requested version');
  assert.ok(resp.result.capabilities.tools, 'advertises tools');
  assert.strictEqual(resp.result.serverInfo.name, 'sidequest');
});

test('notifications/initialized takes no response', () => {
  const resp = mcp.handleRequest({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.strictEqual(resp, null);
});

test('tools/list advertises the board tools with input schemas', () => {
  const resp = mcp.handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = resp.result.tools.map((t) => t.name);
  for (const expected of ['list', 'ready', 'add', 'update', 'remove', 'archive', 'unarchive', 'claim', 'sweepClaims', 'next', 'done', 'release', 'commit', 'submit', 'comment', 'ask', 'link', 'unlink', 'assign', 'dispatch', 'category_add', 'category_edit', 'category_rm', 'category_detach', 'category_relink', 'category_list', 'global_fallback', 'board_config', 'models', 'projects', 'archive_board', 'unarchive_board', 'route_recipe']) {
    assert.ok(names.includes(expected), `exposes ${expected}`);
  }
  for (const cliOnly of ['native_agent', 'native_agent_cleanup']) {
    assert.ok(!names.includes(cliOnly), `${cliOnly} stays CLI-only`);
  }
  for (const t of resp.result.tools) {
    assert.strictEqual(t.inputSchema.type, 'object', `${t.name} has an object input schema`);
  }
});

test('tools/list keeps schemas compact without losing claim and dispatch discipline', () => {
  const tools = mcp.toolDescriptors();
  const descriptionBytes = (value) => {
    if (Array.isArray(value)) return value.reduce((total, entry) => total + descriptionBytes(entry), 0);
    if (!value || typeof value !== 'object') return 0;
    return Object.entries(value).reduce((total, [key, entry]) =>
      total + (key === 'description' && typeof entry === 'string' ? Buffer.byteLength(entry) : descriptionBytes(entry)), 0);
  };
  const total = descriptionBytes(tools);
  assert.ok(total <= 5000, `tool descriptions use ${total} bytes — trim them, don't raise the budget`);
  const payload = JSON.stringify({ tools });
  assert.ok(payload.length <= 15500, `tools/list payload is ${payload.length} bytes — trim schemas, don't raise the budget`);
  assert.match(tools.find((tool) => tool.name === 'claim').description, /ok:true/);
  assert.match(tools.find((tool) => tool.name === 'dispatch').description, /stable route/);
  assert.match(tools.find((tool) => tool.name === 'done').description, /actual model and effort/);
});

test('board_config defaults docs to always-in-scope', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-docs-scope-'));
  fs.mkdirSync(path.join(root, 'docs'));
  const project = store.ensureProject(root, 'SQ docs config').slug;
  assert.deepEqual(callTool('board_config', { project }).alwaysInScope, ['docs/']);
});


test('board_config reads and replaces always-in-scope paths', () => {
  const project = store.ensureProject(path.join(os.tmpdir(), 'sq-mcp-board-config'), 'SQ config').slug;
  const configured = callTool('board_config', { project, alwaysInScope: ['docs', 'notes'] });
  assert.deepEqual(configured.alwaysInScope, ['docs', 'notes']);
  assert.deepEqual(callTool('board_config', { project }).alwaysInScope, ['docs', 'notes']);
});


test('write acks and pulse stay lean: no body echoes, no lifecycle noise by default', () => {
  const project = store.ensureProject(path.join(os.tmpdir(), 'sq-mcp-lean-shapes'), 'SQ lean shapes').slug;
  const ticket = store.createTicket(project, {
    title: 'lean wire shapes', complexity: 2, complexityWhy: 'exercise ack and pulse response shapes',
  });

  const body = 'A long durable handoff body that must never ride back in the ack.\n'.repeat(5);
  const ack = callTool('comment', { project, ref: ticket.ref, body, by: 'shape-tester' });
  assert.equal(ack.ok, true);
  assert.ok(ack.commentId, 'ack carries the comment id');
  assert.ok(ack.at, 'ack carries the timestamp');
  assert.equal(ack.comment, undefined, 'ack must not echo the comment object');
  assert.ok(!JSON.stringify(ack).includes('durable handoff body'), 'ack must not echo the body text');

  const asked = callTool('ask', { project, ref: ticket.ref, body: 'question body, also never echoed', by: 'shape-tester' });
  assert.equal(asked.ok, true);
  assert.ok(asked.commentId && asked.comment === undefined, 'ask ack is id-only too');

  store.prepareDispatch(project, ticket.ref, { sessionId: 'shape-session' });
  const pulse = callTool('pulse', { project, ref: ticket.ref });
  assert.ok(pulse.dispatch, 'pulse still reports dispatch state');
  assert.ok(pulse.dispatch.state, 'slim dispatch keeps state');
  for (const noisy of ['sessionId', 'preparedAt', 'launchedAt', 'boundAt', 'claimedAt', 'terminalAt', 'terminalSource', 'agentId']) {
    assert.ok(!(noisy in pulse.dispatch), `slim pulse omits ${noisy}`);
  }
  const detailed = callTool('pulse', { project, ref: ticket.ref, detail: true });
  assert.ok('preparedAt' in detailed.dispatch, 'detail:true restores the full dispatch lifecycle');
});

test('MCP commit and submit finish an isolated worktree without a PATH command', () => {
  const worktree = createGitWorktree();
  const project = store.ensureProject(worktree).slug;
  const ticket = store.createTicket(project, {
    title: 'MCP terminal lifecycle', files: ['lib/allowed.js'], labels: ['direct-ok'], complexity: 3,
    complexityWhy: 'exercise the MCP commit and submit terminal worktree lifecycle',
  });
  const by = 'mcp-worktree-worker';
  assert.equal(callTool('claim', { project, ref: ticket.ref, by, direct: true, reason: 'The test needs a direct local worktree lifecycle.' }).ok, true);

  fs.mkdirSync(path.join(worktree, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(worktree, 'lib', 'allowed.js'), 'allowed\n');
  fs.writeFileSync(path.join(worktree, 'foreign.js'), 'foreign\n');
  gitAt(worktree, ['add', '.']);
  const explicitPath = process.platform === 'win32' ? worktree.replace(/\//g, '\\') : worktree;
  const committed = callTool('commit', {
    project, ref: ticket.ref, by, message: 'MCP scoped commit', worktree: explicitPath,
  });
  assert.ok(committed.commit, 'commit returns the local hash');
  assert.deepEqual(committed.paths, ['lib/allowed.js']);
  assert.equal(gitAt(worktree, ['diff', '--cached', '--name-only']), 'foreign.js', 'foreign staging remains intact');
  gitAt(worktree, ['update-ref', `refs/sidequest/${ticket.ref}`, committed.commit]);

  const submitted = callTool('submit', {
    project, ref: ticket.ref, by, commit: committed.commit,
    worktree: explicitPath, verify: 'node --test plugins/sidequest/test/mcp.test.js',
    body: 'MCP terminal evidence',
  });
  assert.equal(submitted.ok, true);
  assert.equal(submitted.submission.commit, committed.commit);
  const after = store.getTicket(project, ticket.ref);
  assert.equal(after.claim, null, 'submit releases the claim');
  assert.ok(after.comments.some((comment) => comment.body === 'MCP terminal evidence'));

  const malformed = store.createTicket(project, {
    title: 'MCP malformed submission', files: ['lib/other.js'], labels: ['direct-ok'], complexity: 3,
    complexityWhy: 'confirm malformed MCP submission input preserves the ticket claim',
  });
  assert.equal(callTool('claim', { project, ref: malformed.ref, by: 'mcp-bad-worker', direct: true, reason: 'The malformed submit fixture needs a claim.' }).ok, true);
  const bad = callToolRaw('submit', { project, ref: malformed.ref, by: 'mcp-bad-worker', commit: 'not-a-hash', worktree });
  assert.ok(bad.isError, 'malformed hashes fail before a board write');
  assert.ok(store.getTicket(project, malformed.ref).claim, 'malformed submission keeps the claim');
});

test('MCP submit refuses out-of-scope committed ranges', () => {
  const worktree = createGitWorktree();
  const project = store.ensureProject(worktree).slug;
  const ticket = store.createTicket(project, {
    title: 'MCP range scope refusal', files: ['lib/allowed.js'], labels: ['direct-ok'], complexity: 3,
    complexityWhy: 'confirm MCP submit refuses a committed range outside the declared scope',
  });
  const by = 'mcp-range-worker';
  assert.equal(callTool('claim', { project, ref: ticket.ref, by, direct: true, reason: 'The test needs a direct local worktree lifecycle.' }).ok, true);
  fs.writeFileSync(path.join(worktree, 'foreign.js'), 'foreign\n');
  gitAt(worktree, ['add', 'foreign.js']);
  gitAt(worktree, ['commit', '-m', 'foreign work']);
  const commit = gitAt(worktree, ['rev-parse', 'HEAD']);
  gitAt(worktree, ['update-ref', `refs/sidequest/${ticket.ref}`, commit]);
  const refused = callTool('submit', { project, ref: ticket.ref, by, commit, worktree });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'outside_scope');
  assert.ok(store.getTicket(project, ticket.ref).claim, 'scope refusal keeps the claim');
});

test('sweepClaims releases stale claims through MCP', () => {
  const created = callTool('add', { title: 'MCP stale sweep', unclassified: true });
  const slug = created.project;
  assert.equal(store.claimTicket(slug, created.ref, 'mcp-stale').ok, true);
  const stale = store.getTicket(slug, created.ref);
  stale.claim.at = new Date(Date.now() - store.claimTtlMs() - 1).toISOString();
  const dbModule = require('../lib/db.js');
  dbModule.putRow(dbModule.openDb(SIDEQUEST_HOME), 'tickets', {
    id: stale.id, project: slug, ref: stale.ref, status: stale.status,
    archived: stale.archived ? 1 : 0, ord: stale.order, claim_by: stale.claim.by, data: stale,
  });
  const swept = callTool('sweepClaims', { project: slug });
  assert.equal(swept.released.length, 1);
  assert.equal(store.getTicket(slug, created.ref).claim, null);
});


test('MCP board archive tools match the CLI archive-board lifecycle', () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-board-archive-'));
  const project = store.ensureProject(projectPath).slug;
  const cliArchived = runCli(['archive-board', project, '--json']);
  assert.equal(cliArchived.ok, true);
  assert.ok(store.findProject(project).meta.archivedAt);

  const restored = callTool('unarchive_board', { project });
  assert.equal(restored.ok, true);
  assert.equal(store.findProject(project).meta.archivedAt, undefined);

  const archived = callTool('archive_board', { project });
  assert.equal(archived.ok, true);
  assert.ok(store.findProject(project).meta.archivedAt);

  const cliRestored = runCli(['unarchive-board', project, '--json']);
  assert.equal(cliRestored.ok, true);
  assert.equal(store.findProject(project).meta.archivedAt, undefined);
});
test('dispatch returns a stable executor, one spawn prompt, and a token', () => {
  const d = mcp.toolDescriptors().find((t) => t.name === 'dispatch');
  assert.ok(d);
  assert.deepStrictEqual(Object.keys(d.inputSchema.properties).sort(), ['project', 'ref', 'sharedTree']);
  assert.deepStrictEqual(d.inputSchema.required, ['ref']);

  seedCatalog([{ slug: 'codex-gpt-5-6-terra', id: 'claude-codex-gpt-5.6-terra', label: 'Terra' }]);
  store.setCategory({ id: 'dispatch-codex', name: 'Dispatch Codex', route: { model: 'codex-gpt-5-6-terra', effort: 'high' } });
  const slug = store.ensureProject(PROJ).slug;

  const addedInstant = callTool('add', { title: 'instant dispatch', description: DISPATCH_DESCRIPTION, category: 'dispatch-codex' });
  const instant = callTool('dispatch', { ref: addedInstant.ref, session: 'mcp-dispatch-session' });
  assert.equal(instant.mode, 'instant');
  assert.deepEqual(instant.exec, {
    agent: 'sidequest-exec-dispatch-high', model: null, backend: 'codex',
    runsModel: 'codex-gpt-5-6-terra', apiModel: 'claude-codex-gpt-5.6-terra',
    runsLabel: 'Terra', dispatch: 'native-agent',
  });
  assert.equal(instant.agent, 'sidequest-exec-dispatch-high');
  assert.equal(instant.spawn.description, 'instant dispatch (Terra)');
  assert.equal(instant.spawn.model, undefined);
  assert.equal(instant.spawn.subagent_type, instant.agent);
  assert.equal(instant.tokenPrefix, instant.token.slice(0, 12));
  assert.equal(Object.hasOwn(instant, 'briefing'), false);
  assert.ok(Buffer.byteLength(instant.spawn.prompt) < 600, `dispatch stub is ${Buffer.byteLength(instant.spawn.prompt)} bytes`);
  assert.match(instant.spawn.prompt, new RegExp(`briefing ${addedInstant.ref} --token ${instant.token}`));
  assert.match(instant.spawn.prompt, /FIRST action:/);
  assert.match(instant.spawn.prompt, /\[sidequest-route model=gpt-5\.6-terra effort=high\]/);
  assert.doesNotMatch(instant.spawn.prompt, /## This ticket/);
  assert.doesNotMatch(instant.spawn.prompt, /You are a sidequest ticket executor/);
  assert.doesNotMatch(instant.spawn.prompt, /^---$/m);
  const expectedBriefing = agentsync.withProjectIdentity(agentsync.renderTicketBriefing(
    store.getTicket(slug, addedInstant.ref), instant.token,
  ), PROJ);
  const cli = path.join(__dirname, '..', 'bin', 'sidequest.js');
  const printedBriefing = execFileSync(process.execPath, [cli, 'briefing', addedInstant.ref, '--token', instant.token, '--project', PROJ], {
    encoding: 'utf8', windowsHide: true,
    env: Object.assign({}, process.env, { SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: PROJ }),
  });
  assert.strictEqual(printedBriefing, expectedBriefing);
  assert.match(instant.guidance, /executor/);
  assert.equal(store.getTicket(slug, addedInstant.ref).dispatchExecutor, instant.agent);

  const adopted = callTool('dispatch', { ref: addedInstant.ref, session: 'adopting-session' });
  assert.equal(adopted.mode, 'instant');
  assert.equal(adopted.agent, instant.agent);
  assert.notEqual(adopted.token, instant.token);
  assert.equal(Object.hasOwn(adopted, 'briefing'), false);
  assert.match(adopted.spawn.prompt, new RegExp(`briefing ${addedInstant.ref} --token ${adopted.token}`));
  const staleBriefing = spawnSync(process.execPath, [cli, 'briefing', addedInstant.ref, '--token', instant.token, '--project', PROJ], {
    encoding: 'utf8', windowsHide: true,
    env: Object.assign({}, process.env, { SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: PROJ }),
  });
  assert.equal(staleBriefing.status, 1);
  assert.match(staleBriefing.stderr, /dispatch token was refused/);
  assert.doesNotMatch(JSON.stringify(adopted), /ephemeral/);
});

test('MCP dispatch records the runtime session and the Agent lifecycle binds it', () => {
  const slug = store.ensureProject(PROJ).slug;
  store.setCategory({ id: 'mcp-runtime-session', name: 'MCP runtime session', route: { model: 'sonnet', effort: 'high' } });
  const friendly = callTool('add', { title: 'friendly dispatch session', description: DISPATCH_DESCRIPTION, category: 'mcp-runtime-session' });
  const omitted = callTool('add', { title: 'omitted dispatch session', description: DISPATCH_DESCRIPTION, category: 'mcp-runtime-session' });
  const real = callTool('add', { title: 'runtime dispatch session', description: DISPATCH_DESCRIPTION, category: 'mcp-runtime-session' });

  const friendlyDispatch = callTool('dispatch', { ref: friendly.ref, session: 'hh6-quant' });
  callTool('dispatch', { ref: omitted.ref });
  callTool('dispatch', { ref: real.ref, session: MCP_SESSION_ID });

  for (const ref of [friendly.ref, omitted.ref, real.ref]) {
    assert.equal(store.getTicket(slug, ref).dispatch.sessionId, MCP_SESSION_ID);
  }

  const launched = runForceBypass({
    session_id: MCP_SESSION_ID,
    cwd: PROJ,
    tool_name: 'Agent',
    tool_input: friendlyDispatch.spawn,
  });
  const agentName = launched.hookSpecificOutput.updatedInput.name;
  let pulse = callTool('pulse', { ref: friendly.ref, detail: true });
  assert.equal(pulse.dispatch.state, 'launched');
  assert.equal(pulse.dispatch.sessionId, MCP_SESSION_ID);
  assert.ok(pulse.dispatch.launchedAt);

  assert.equal(store.bindDispatchAgent(MCP_SESSION_ID, friendlyDispatch.agent, 'native-mcp-session-agent', agentName).ok, true);
  pulse = callTool('pulse', { ref: friendly.ref, detail: true });
  assert.equal(pulse.dispatch.state, 'bound');
  assert.equal(pulse.dispatch.agentId, 'native-mcp-session-agent');
});

test('MCP dispatch refuses a caller session label without runtime identity', () => {
  const slug = store.ensureProject(PROJ).slug;
  const ticket = callTool('add', { title: 'missing runtime dispatch session', description: DISPATCH_DESCRIPTION, category: 'mcp-runtime-session' });
  const runtime = process.env.CLAUDE_CODE_SESSION_ID;
  const legacy = process.env.CLAUDE_SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CLAUDE_SESSION_ID;
  try {
    const refused = callToolRaw('dispatch', { ref: ticket.ref, session: 'hh6-review' });
    assert.ok(refused.isError);
    assert.equal(refused.content[0].text, 'dispatch: MCP runtime session identity is unavailable. Reload Sidequest in Claude Code and retry; do not pass a session label.');
    assert.equal(store.getTicket(slug, ticket.ref).dispatch, null);
  } finally {
    process.env.CLAUDE_CODE_SESSION_ID = runtime;
    if (legacy == null) delete process.env.CLAUDE_SESSION_ID;
    else process.env.CLAUDE_SESSION_ID = legacy;
  }
});

test('dispatch returns a complete Claude worktree spawn spec', () => {
  store.setCategory({ id: 'dispatch-fable', name: 'Dispatch Fable', route: { model: 'fable', effort: 'xhigh' } });
  const added = callTool('add', { title: 'complete instant spawn', description: DISPATCH_DESCRIPTION, category: 'dispatch-fable', files: ['plugins/sidequest'] });
  const dispatched = callTool('dispatch', { ref: added.ref });

  const { prompt, ...spawn } = dispatched.spawn;
  assert.deepStrictEqual(spawn, {
    subagent_type: 'sidequest-exec-xhigh',
    name: 'sidequest-exec-xhigh',
    mode: 'bypassPermissions',
    description: 'complete instant spawn',
    isolation: 'worktree',
    model: 'fable',
  });
  assert.match(prompt, /briefing SQ-/);
  assert.match(prompt, /Dispatch board identity: --project/);
  assert.doesNotMatch(prompt, /## This ticket/);
  assert.doesNotMatch(prompt, /You are a sidequest ticket executor/);
  assert.equal(dispatched.effort, 'xhigh');
  assert.equal(dispatched.projectPath, PROJ);
});

test('MCP shared-tree dispatch activates the bounded artifact lifecycle', () => {
  store.setCategory({ id: 'dispatch-artifact', name: 'Dispatch Artifact', route: { model: 'sonnet', effort: 'medium' } });
  const added = callTool('add', {
    title: 'shared-tree artifact',
    description: `Write only the declared documentation artifact.\n${store.SHARED_TREE_ARTIFACT_MARKER}`,
    category: 'dispatch-artifact',
    files: ['.claude/.codebase-info/'],
  });
  const dispatched = callTool('dispatch', { ref: added.ref, sharedTree: true });
  const stored = store.getTicket(added.project, added.ref);

  assert.strictEqual(dispatched.spawn.isolation, undefined);
  assert.strictEqual(stored.dispatch.sharedTree, true);
  assert.strictEqual(stored.dispatch.artifactMode, true);
  assert.match(agentsync.renderTicketBriefing(stored, dispatched.token), /\[sidequest-artifact-mode\]/);
});

test('native_agent carries ticket anchors and verify command through its stable fallback', () => {
  seedCatalog([{ slug: 'codex-gpt-5-6-terra', id: 'claude-codex-gpt-5.6-terra', label: 'Terra' }]);
  try {
    store.setCategory({ id: 'native-codex', name: 'Native Codex', route: { model: 'codex-gpt-5-6-terra', effort: 'high' } });
    const added = callTool('add', {
      title: 'prompt context', category: 'native-codex',
      anchors: 'lib/work.js:14 executorPrompt', verify: 'node --test plugins/sidequest/test/work.test.js',
    });
    const native = callHandler('native_agent', { ref: added.ref, prompt: 'Implement exactly this ticket.' });
    assert.strictEqual(native.fallback, true);
    assert.strictEqual(native.file, null);
    assert.strictEqual(native.spawn.subagent_type, 'sidequest-exec-dispatch-high');
    assert.strictEqual(native.spawn.description, 'prompt context (Terra)');
    assert.strictEqual(native.spawn.model, undefined);
    assert.match(native.prompt, /Authoritative ticket contract \(the task prompt may add logistics only; do not narrow this scope\):/);
    assert.match(native.prompt, /Title: prompt context/);
    assert.match(native.prompt, /Anchors:\nlib\/work\.js:14 executorPrompt/);
    assert.match(native.prompt, /Verify command:\nnode --test plugins\/sidequest\/test\/work\.test\.js/);
  } finally {
    clearCatalog();
  }
});

test('native_agent returns a complete Claude worktree spawn spec', () => {
  store.setCategory({ id: 'native-fable', name: 'Native Fable', route: { model: 'fable', effort: 'xhigh' } });
  const added = callTool('add', { title: 'complete native spawn', category: 'native-fable', files: ['plugins/sidequest'] });
  const native = callHandler('native_agent', { ref: added.ref, prompt: 'Implement the ticket.' });

  assert.deepStrictEqual(native.spawn, {
    subagent_type: 'sidequest-exec-xhigh',
    name: 'sidequest-native-' + added.ref.toLowerCase() + '-fable',
    mode: 'bypassPermissions',
    description: 'complete native spawn',
    isolation: 'worktree',
    model: 'fable',
    prompt: native.prompt,
  });
  assert.equal(native.effort, 'xhigh');
  assert.equal(native.projectPath, PROJ);
  assert.match(native.spawn.prompt, new RegExp(`--project "${PROJ.replace(/\\/g, '\\\\')}"`));
});

test('native_agent isolates declared-file tickets unless shared-tree is requested', () => {
  seedCatalog([{ slug: 'codex-gpt-5-6-terra', id: 'claude-codex-gpt-5.6-terra', label: 'Terra' }]);
  try {
    store.setCategory({ id: 'native-worktree', name: 'Native Worktree', route: { model: 'codex-gpt-5-6-terra', effort: 'high' } });
    const added = callTool('add', { title: 'worktree dispatch', category: 'native-worktree', files: ['plugins/sidequest'] });
    const isolated = callHandler('native_agent', { ref: added.ref, prompt: 'Implement the ticket.' });
    const shared = callHandler('native_agent', { ref: added.ref, prompt: 'Implement the ticket.', sharedTree: true });
    assert.equal(isolated.spawn.isolation, 'worktree');
    assert.equal(shared.spawn.isolation, undefined);
  } finally {
    clearCatalog();
  }
});

test('an unknown method is a JSON-RPC method-not-found error', () => {
  const resp = mcp.handleRequest({ jsonrpc: '2.0', id: 3, method: 'does/not/exist' });
  assert.ok(resp.error, 'returns an error object');
  assert.strictEqual(resp.error.code, -32601);
});

test('add rejects incomplete routing inputs', () => {
  assert.ok(callToolRaw('add', { title: 'no score' }).isError, 'missing complexity/why errors');
  assert.ok(callToolRaw('add', { title: 'bad', complexity: 3, why: 'too short' }).isError, 'a thin why errors');
  assert.ok(callToolRaw('add', { title: 'direct', complexity: 3, why: 'x'.repeat(25), model: 'grade-3' }).isError, 'a direct model errors');
});
test('add returns a compact category acknowledgement', () => {
  const out = callTool('add', { title: 'MCP add works', complexity: 3, why: 'a real motivation referencing the actual single-file change' });
  assert.deepStrictEqual(Object.keys(out).sort(), ['category', 'ok', 'project', 'ref', 'status', 'title']);
  assert.match(out.ref, /^SQ-\d+$/);
  assert.strictEqual(out.status, 'todo');
  assert.equal(typeof out.category.name, 'string');
  assert.equal(typeof out.category.description, 'string');
  assert.equal(typeof out.category.route.model, 'string');
});

test('category stamps warn until category_list is served by the MCP session', () => {
  const session = freshMcpServer();
  const slug = store.ensureProject(PROJ).slug;
  const existing = store.createTicket(slug, { title: 'update without category', category: 'mechanical' });
  const unchangedCategory = callToolOn(session, 'update', { ref: existing.ref, title: 'update without a category stamp' });
  assert.equal(unchangedCategory.warnings, undefined);

  const warned = callToolOn(session, 'add', { title: 'category stamped before read', category: 'mechanical' });
  assert.deepEqual(warned.warnings, ['Category stamped without reading the taxonomy this session — run category_list and confirm the description matches.']);

  callToolOn(session, 'category_list', {});
  const acknowledged = callToolOn(session, 'add', { title: 'category stamped after read', category: 'mechanical' });
  assert.equal(acknowledged.warnings, undefined);

  callTool('category_list', {});
});

test('dispatch rejects a thin routed brief but only warns about a missing coding verify command', () => {
  const added = callTool('add', { title: 'thin dispatch fixture', category: 'debugging' });
  assert.equal(added.ok, true);
  const refused = callToolRaw('dispatch', { ref: added.ref });
  assert.ok(refused.isError);
  assert.match(refused.content[0].text, /executor's entire brief is this ticket/);

  callTool('update', { ref: added.ref, description: DISPATCH_DESCRIPTION });
  const dispatched = callTool('dispatch', { ref: added.ref });
  assert.match(dispatched.warnings[0], /no verify command/);

  const research = callTool('add', { title: 'research dispatch fixture', description: DISPATCH_DESCRIPTION, category: 'deep-research' });
  assert.deepEqual(callTool('dispatch', { ref: research.ref }).warnings, []);
});

test('update returns only its changed fields', () => {
  store.setCategory({ id: 'mcp-update-echo', name: 'MCP update echo', route: { model: 'opus', effort: 'high' } });
  const added = callTool('add', { title: 'MCP update echo', category: 'mechanical' });
  const updated = callTool('update', { ref: added.ref, category: 'mcp-update-echo' });
  assert.deepStrictEqual(Object.keys(updated).sort(), ['category', 'categoryId', 'ok', 'project', 'ref', 'status']);
  assert.strictEqual(updated.categoryId, 'mcp-update-echo');
  assert.equal(updated.category.name, 'MCP update echo');
  assert.equal(updated.category.route.model, 'opus');
});

test('add and update attach unknown ticket-ref warnings to compact acknowledgements', () => {
  const known = callTool('add', { title: 'known ticket', unclassified: true });
  const added = callTool('add', { title: `use ${known.ref} and SQ-9999`, unclassified: true });
  assert.deepStrictEqual(added.warnings, ['Unknown ticket refs: SQ-9999.']);

  const updated = callTool('update', { ref: added.ref, description: 'now use SQ-9998' });
  assert.deepStrictEqual(updated.warnings, ['Unknown ticket refs: SQ-9999, SQ-9998.']);
});

test('status validation fails loudly and directs deletion to remove', () => {
  const added = callTool('add', { title: 'strict status', complexity: 1, why: 'exercise loud validation for invalid MCP status values' });
  const invalid = callToolRaw('update', { ref: added.ref, status: 'deleted' });
  assert.ok(invalid.isError);
  assert.match(invalid.content[0].text, /Valid statuses: todo, doing, done/);
  assert.match(invalid.content[0].text, /remove tool/i);
  assert.throws(() => store.updateTicket(store.ensureProject(PROJ).slug, added.ref, { status: 'deleted' }), /remove tool/i);
  assert.throws(() => store.createTicket(store.ensureProject(PROJ).slug, { title: 'bad status', status: 'deleted' }), /remove tool/i);
});

test('CLI and MCP remove protect live claims but allow force and stale claims', () => {
  const cliLive = callTool('add', { title: 'CLI live claim removal', unclassified: true });
  assert.equal(store.claimTicket(cliLive.project, cliLive.ref, 'cli-live-worker', { direct: true }).ok, true);
  assert.throws(
    () => runCli(['rm', cliLive.ref, '--project', cliLive.project]),
    (error) => /live-claimed by "cli-live-worker".*--force/.test(error.stderr)
  );
  assert.ok(store.getTicket(cliLive.project, cliLive.ref));
  runCli(['rm', cliLive.ref, '--force', '--project', cliLive.project]);
  assert.equal(store.getTicket(cliLive.project, cliLive.ref), null);

  const cliStale = callTool('add', { title: 'CLI stale claim removal', unclassified: true });
  assert.equal(store.claimTicket(cliStale.project, cliStale.ref, 'cli-stale-worker', { direct: true }).ok, true);
  const staleCliTicket = store.getTicket(cliStale.project, cliStale.ref);
  staleCliTicket.claim.at = new Date(Date.now() - store.claimTtlMs() - 1).toISOString();
  const db = require('../lib/db.js');
  db.putRow(db.openDb(SIDEQUEST_HOME), 'tickets', {
    id: staleCliTicket.id, project: cliStale.project, ref: staleCliTicket.ref, status: staleCliTicket.status,
    archived: staleCliTicket.archived ? 1 : 0, ord: staleCliTicket.order, claim_by: staleCliTicket.claim.by, data: staleCliTicket,
  });
  runCli(['rm', cliStale.ref, '--project', cliStale.project]);
  assert.equal(store.getTicket(cliStale.project, cliStale.ref), null);

  const mcpLive = callTool('add', { title: 'MCP live claim removal', unclassified: true });
  assert.equal(store.claimTicket(mcpLive.project, mcpLive.ref, 'mcp-live-worker', { direct: true }).ok, true);
  const refused = callTool('remove', { project: mcpLive.project, ref: mcpLive.ref });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'claimed');
  assert.equal(refused.claim.by, 'mcp-live-worker');
  assert.ok(store.getTicket(mcpLive.project, mcpLive.ref));
  assert.equal(callTool('remove', { project: mcpLive.project, ref: mcpLive.ref, force: true }).ok, true);
  assert.equal(store.getTicket(mcpLive.project, mcpLive.ref), null);

  const mcpStale = callTool('add', { title: 'MCP stale claim removal', unclassified: true });
  assert.equal(store.claimTicket(mcpStale.project, mcpStale.ref, 'mcp-stale-worker', { direct: true }).ok, true);
  const staleMcpTicket = store.getTicket(mcpStale.project, mcpStale.ref);
  staleMcpTicket.claim.at = new Date(Date.now() - store.claimTtlMs() - 1).toISOString();
  db.putRow(db.openDb(SIDEQUEST_HOME), 'tickets', {
    id: staleMcpTicket.id, project: mcpStale.project, ref: staleMcpTicket.ref, status: staleMcpTicket.status,
    archived: staleMcpTicket.archived ? 1 : 0, ord: staleMcpTicket.order, claim_by: staleMcpTicket.claim.by, data: staleMcpTicket,
  });
  assert.equal(callTool('remove', { project: mcpStale.project, ref: mcpStale.ref }).ok, true);
  assert.equal(store.getTicket(mcpStale.project, mcpStale.ref), null);
});

test('MCP archive and unarchive match the CLI ticket archive lifecycle', () => {
  const cliTicket = callTool('add', { title: 'CLI ticket archive', unclassified: true });
  const cliArchived = runCli(['archive', cliTicket.ref, '--project', cliTicket.project, '--json']);
  assert.equal(cliArchived.ok, true);
  assert.equal(store.getTicket(cliTicket.project, cliTicket.ref).archived, true);

  const restored = callTool('unarchive', { project: cliTicket.project, ref: cliTicket.ref });
  assert.equal(restored.ok, true);
  assert.equal(store.getTicket(cliTicket.project, cliTicket.ref).archived, false);

  const mcpTicket = callTool('add', { title: 'MCP ticket archive', unclassified: true });
  const archived = callTool('archive', { project: mcpTicket.project, ref: mcpTicket.ref });
  assert.equal(archived.ok, true);
  assert.equal(store.getTicket(mcpTicket.project, mcpTicket.ref).archived, true);

  const cliRestored = runCli(['unarchive', mcpTicket.ref, '--project', mcpTicket.project, '--json']);
  assert.equal(cliRestored.ok, true);
  assert.equal(store.getTicket(mcpTicket.project, mcpTicket.ref).archived, false);
});

test('MCP admin/config tools share CLI state transitions', () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-admin-'));
  const project = store.ensureProject(projectPath).slug;
  const categoryId = `mcp-admin-${process.pid}`;
  const fallback = store.getRoutingFallback();
  try {
    const cliCategory = runCli(['category', 'add', categoryId, '--name', 'MCP admin category', '--route-model', 'sonnet', '--route-effort', 'low', '--json']);
    assert.equal(cliCategory.ok, true);
    assert.equal(callTool('category_detach', { project, id: categoryId }).localRow.kind, 'DETACH');
    const relinked = runCli(['category', 'relink', categoryId, '--project', project, '--json']);
    assert.equal(relinked.localRow, null);

    const mcpFallback = callTool('global_fallback', { project, model: 'sonnet', effort: 'low' });
    assert.deepEqual(runCli(['global-fallback', '--project', project, '--json']).fallback, mcpFallback.fallback);
    const cliFallback = runCli(['global-fallback', '--project', project, '--model', 'opus', '--effort', 'high', '--json']);
    assert.deepEqual(callTool('global_fallback', { project }).fallback, cliFallback.fallback);

    const a = callTool('add', { project, title: 'CLI assignment and link', unclassified: true });
    const b = callTool('add', { project, title: 'MCP assignment and unlink', unclassified: true });
    assert.equal(runCli(['assign', a.ref, '--project', project, '--to', 'cli-owner', '--json']).ticket.assignee, 'cli-owner');
    assert.equal(callTool('assign', { project, ref: a.ref, to: 'mcp-owner' }).assignee, 'mcp-owner');
    assert.equal(runCli(['link', a.ref, 'related', b.ref, '--project', project, '--json']).ok, true);
    assert.equal(callTool('unlink', { project, a: a.ref, b: b.ref }).ok, true);
    assert.equal(store.getTicket(project, a.ref).links.length, 0);

    assert.deepEqual(callTool('models', { project }), runCli(['models', '--project', project, '--json']));
    assert.deepEqual(callTool('projects', {}), runCli(['projects', '--json']));
    assert.equal(callTool('category_rm', { id: categoryId }).ok, true);

    const mcpCategoryId = `${categoryId}-mcp`;
    assert.equal(callTool('category_add', {
      id: mcpCategoryId, name: 'MCP-created admin category', routeModel: 'sonnet', routeEffort: 'low',
    }).ok, true);
    assert.ok(runCli(['category', 'list', '--json']).categories.some((category) => category.id === mcpCategoryId));
    assert.equal(runCli(['category', 'rm', mcpCategoryId, '--json']).ok, true);
  } finally {
    if (fallback) store.setRoutingFallback(fallback);
  }
});


test('claim -> comment -> done return compact acknowledgements', () => {
  const added = callTool('add', { title: 'work me', complexity: 2, why: 'a mechanical change to exercise the claim/done path over MCP', labels: ['direct-ok'] });
  const ref = added.ref;
  const ticket = store.getTicket(added.project, ref);

  const claim = callTool('claim', { ref, by: 'mcp-worker-1', direct: true, reason: 'This compact acknowledgement test owns the ticket.' });
  assert.deepStrictEqual(Object.keys(claim).sort(), ['claim', 'ok', 'project', 'ref', 'status']);
  assert.strictEqual(claim.status, 'doing');

  const note = callTool('comment', { ref, body: 'progress note from an MCP tool call' });
  assert.deepStrictEqual(Object.keys(note).sort(), ['at', 'commentId', 'ok', 'project', 'ref', 'status']);
  const stored = store.getTicket(added.project, ref).comments.at(-1);
  assert.strictEqual(stored.source, 'mcp', 'MCP actions are tagged as background (not dashboard)');

  const done = callTool('done', { ref, by: 'mcp-worker-1', model: ticket.model, effort: ticket.effort });
  assert.deepStrictEqual(Object.keys(done).sort(), ['ok', 'project', 'ref', 'status', 'workedBy']);
  assert.strictEqual(done.status, 'done');
});

test('SQ-174: a spaced comment round-trips with spaces intact and no NUL bytes', () => {
  const added = callTool('add', { title: 'spaces intact', complexity: 1, why: 'exercise the MCP comment write path preserves internal spaces verbatim' });
  const ref = added.ref;
  const body = 'alpha  beta   gamma    delta'; // 2, 3, then 4 internal spaces
  const posted = callTool('comment', { ref, body });
  assert.strictEqual(posted.ok, true);
  const back = callTool('comments', { ref });
  const stored = back.comments[back.comments.length - 1].body;
  assert.strictEqual(stored, body, 'the stored body equals the posted body verbatim');
  assert.ok(!stored.includes('\u0000'), 'no NUL byte anywhere in the stored body');
  assert.strictEqual((stored.match(/ /g) || []).length, 9, 'all nine internal spaces survive');
});

test('SQ-174: an author-supplied NUL (a NUL-separated key in prose) is stripped, not persisted', () => {
  const added = callTool('add', { title: 'nul stripped', complexity: 1, why: 'a comment describing a NUL-separated dedup key must not persist the raw 0x00' });
  const ref = added.ref;
  // Mirrors the real SQ-171 note that misfired: `source + '\0' + slug`, but with
  // a genuine 0x00 char between the quotes (as the reporter's body had).
  const body = 'dedup key: source + \u0000 + slug (works)';
  const posted = callTool('comment', { ref, body });
  assert.strictEqual(posted.ok, true, 'the comment still stores (a lone control byte is normalized, not rejected)');
  const back = callTool('comments', { ref });
  const stored = back.comments[back.comments.length - 1].body;
  assert.ok(!stored.includes('\u0000'), 'the raw NUL is gone from storage');
  assert.strictEqual(stored, 'dedup key: source +  + slug (works)', 'only the NUL is removed; surrounding spaces stay');
});

test('SQ-404: long handoff comments are stored whole and still have a clear cap', () => {
  const added = callTool('add', { title: 'long handoff', complexity: 1, why: 'confirm durable evidence can outlast the bounded executor digest' });
  const ref = added.ref;

  const handoff = 'x'.repeat(5481);
  const stored = callTool('comment', { ref, body: handoff });
  assert.strictEqual(stored.ok, true, 'a useful long handoff stores whole');
  assert.strictEqual(callTool('comments', { ref }).comments[0].body.length, 5481);

  const tooLong = 'x'.repeat(16001);
  const rejected = callTool('comment', { ref, body: tooLong });
  assert.strictEqual(rejected.ok, false, 'the storage cap still rejects oversized bodies');
  assert.strictEqual(rejected.reason, 'too_long');
  assert.strictEqual(rejected.max, 16000, 'the error names the expanded cap');
  assert.strictEqual(rejected.length, 16001, 'the error names the actual length');
});

test('claim requires a worker id (no shared-identity default)', () => {
  const added = callTool('add', { title: 'needs by', complexity: 2, why: 'confirm the atomic-claim identity guard is enforced over MCP' });
  const res = callToolRaw('claim', { ref: added.ref });
  assert.ok(res.isError, 'a claim without by is refused');
  assert.match(res.content[0].text, /by.*required/i);
});

test('MCP claim passes prepared dispatch token and executor through to the store', () => {
  seedCatalog([{ id: 'claude-codex-gpt-5.6-terra[1m]', slug: 'codex-gpt-5-6-terra', label: 'GPT-5.6 Terra' }]);
  store.setCategory({ id: 'mcp-dispatch-claim', name: 'MCP dispatch claim', route: { model: 'codex-gpt-5-6-terra', effort: 'high' } });
  const added = callTool('add', { title: 'nonce through MCP', category: 'mcp-dispatch-claim' });
  const slug = store.ensureProject(PROJ).slug;
  const prepared = store.prepareDispatch(slug, added.ref);
  const refused = callTool('claim', { ref: added.ref, by: 'mcp-no-token' });
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.reason, 'token');
  const accepted = callTool('claim', { ref: added.ref, by: 'mcp-with-token', token: prepared.token, executor: prepared.ticket.dispatchExecutor });
  assert.strictEqual(accepted.ok, true);
});

test('MCP requires direct-ok for routed direct claims and records approved bypasses', () => {
  const added = callTool('add', { title: 'no-file research', category: 'mechanical' });
  const ticket = store.getTicket(added.project, added.ref);
  assert.deepStrictEqual(ticket.files, []);
  const refused = callTool('claim', { ref: added.ref, by: 'mcp-routed', effort: ticket.effort, executor: ticket.exec.agent });
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.reason, 'dispatch_required');
  assert.match(refused.message, /dispatch/i);
  assert.match(refused.message, /direct:true/i);
  const reason = 'No executor can access this isolated test fixture.';
  const denied = callTool('claim', { ref: added.ref, by: 'mcp-inline', direct: true, reason });
  assert.strictEqual(denied.ok, false);
  assert.strictEqual(denied.reason, 'direct_not_allowed');
  assert.match(denied.message, new RegExp(`${ticket.model}\\s*·\\s*${ticket.effort}`));
  assert.match(denied.message, /context already loaded/i);
  assert.match(denied.message, /small change/i);
  assert.match(denied.message, /handoff\/transfer cost/i);
  assert.match(denied.message, /retroactively legitimize prior inline investigation/i);
  assert.equal(store.getTicket(added.project, added.ref).claim, null);

  store.updateTicket(added.project, added.ref, { labels: ['direct-ok'] });
  const missingReason = callTool('claim', { ref: added.ref, by: 'mcp-inline', direct: true });
  assert.strictEqual(missingReason.ok, false);
  assert.strictEqual(missingReason.reason, 'direct_reason_required');
  assert.match(missingReason.message, /reason/i);
  const direct = callTool('claim', { ref: added.ref, by: 'mcp-inline', direct: true, reason });
  assert.strictEqual(direct.ok, true);
  const pulse = callTool('pulse', { ref: added.ref });
  assert.strictEqual(pulse.direct.by, 'mcp-inline');
  assert.strictEqual(pulse.direct.model, ticket.model);
  assert.strictEqual(pulse.direct.reason, reason);
});

test('MCP claim rejects a generic executor for a Codex route', () => {
  seedCatalog([{ id: 'claude-codex-gpt-5.6-terra[1m]', slug: 'codex-gpt-5-6-terra', label: 'GPT-5.6 Terra' }]);
  try {
    store.setCategory({ id: 'claim-codex', name: 'Claim Codex', route: { model: 'codex-gpt-5-6-terra', effort: 'high' } });
    const added = callTool('add', { title: 'Codex executor guard', category: 'claim-codex' });
    const ticket = store.getTicket(store.ensureProject(PROJ).slug, added.ref);
    const rejected = callTool('claim', { ref: added.ref, by: 'mcp-generic', effort: ticket.effort, executor: `sidequest-exec-${ticket.effort}` });
    assert.strictEqual(rejected.ok, false);
    assert.strictEqual(rejected.reason, 'executor_mismatch');
    assert.strictEqual(rejected.expectedExecutor, ticket.exec.agent);
  } finally {
    clearCatalog();
  }
});

test('claim with a mismatched effort is refused (drift guard mirrors the CLI)', () => {
  const added = callTool('add', { title: 'effort guard', category: 'mechanical' });
  const ref = added.ref;
  const derived = store.getTicket(added.project, added.ref).effort;
  assert.ok(derived, 'routing on -> a derived effort');
  const wrong = store.VALID_EFFORTS.find((e) => e !== derived);
  const res = callTool('claim', { ref, by: 'mcp-w', effort: wrong });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'effort_mismatch');
  assert.strictEqual(res.derivedEffort, derived);
  // The ticket must stay unclaimed after a refused claim.
  const after = callTool('list', {});
  const t = after.tickets.find((x) => x.ref === ref);
  assert.strictEqual(t.status, 'todo');
  assert.strictEqual(t.claim, null);
});

test('MCP board reads omit category taxonomy while preserving claim TTL and category rows', () => {
  const added = callTool('add', { title: 'trimmed taxonomy response', category: 'mechanical' });
  const list = callTool('list', {});
  const ready = callTool('ready', { brief: true });
  const changes = callTool('changes', {});
  const pulse = callTool('pulse', { ref: added.ref });

  assert.equal(list.categories, undefined);
  assert.equal(ready.categories, undefined);
  assert.equal(changes.categories, undefined);
  assert.equal(pulse.categories, undefined);
  assert.equal(typeof list.claimTtlMs, 'number');
  assert.equal(typeof ready.claimTtlMs, 'number');
  assert.equal(list.tickets.find((ticket) => ticket.ref === added.ref).categoryId, 'mechanical');
  assert.equal(typeof ready.tickets.find((ticket) => ticket.ref === added.ref).categoryName, 'string');
});

test('MCP brief ready response stays under 2 KB', () => {
  const small = store.ensureProject(path.join(os.tmpdir(), 'sq-mcp-trimmed-ready'), 'SQ trimmed ready');
  store.createTicket(small.slug, { title: 'the only ticket', category: 'mechanical' });
  const out = callToolRaw('ready', { project: small.slug, brief: true });
  assert.ok(out.content[0].text.length < 2048, `brief ready response is ${out.content[0].text.length} bytes`);
});

test('the real stdio server frames newline-delimited JSON-RPC', () => {
  const BIN = path.join(__dirname, '..', 'bin', 'sidequest-mcp.js');
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list', arguments: {} } },
  ];
  const input = requests.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const env = Object.assign({}, process.env, { SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: PROJ });
  const res = spawnSync(process.execPath, [BIN], { input, encoding: 'utf8', env, timeout: 10000 });
  const lines = (res.stdout || '').split('\n').filter((l) => l.trim());
  const parsed = lines.map((l) => JSON.parse(l));
  // Three responses (the notification produced none).
  assert.strictEqual(parsed.length, 3, `expected 3 responses, got ${parsed.length}: ${res.stdout}`);
  assert.strictEqual(parsed[0].id, 1);
  assert.ok(parsed[0].result.serverInfo);
  assert.strictEqual(parsed[1].id, 2);
  assert.ok(Array.isArray(parsed[1].result.tools));
  assert.strictEqual(parsed[2].id, 3);
  assert.ok(!parsed[2].result.isError, 'list tool call succeeded');
});

test('models reports concrete routes and no grade output', () => {
  seedCatalog([{ slug: 'codex-terra', id: 'claude-codex-gpt-5.6-terra[1m]', label: 'Codex Terra' }]);
  try {
    store.setCategory({ id: 'model-codex', name: 'Model Codex', route: { model: 'codex-terra', effort: 'high' }, fallback: { model: 'opus', effort: 'high' } });
    const out = callHandler('models', {});
    assert.ok(out.models.includes('codex-terra'));
    assert.ok(out.categories.some((category) => category.id === 'model-codex' && category.resolved.model === 'codex-terra'));
    assert.ok(!JSON.stringify(out).includes('grade-'));
  } finally {
    clearCatalog();
  }
});

test('route_recipe resolves a live route and makes category errors explicit', () => {
  seedCatalog([{ slug: 'codex-terra', id: 'claude-codex-gpt-5.6-terra[1m]', label: 'Codex Terra' }]);
  try {
    store.setCategory({ id: 'recipe-codex', name: 'Recipe Codex', route: { model: 'codex-terra', effort: 'high' } });
    const recipe = callTool('route_recipe', { category: 'recipe-codex' });
    assert.deepEqual(recipe.route, { model: 'codex-terra', effort: 'high' });
    assert.deepEqual(recipe.agent, {
      model: agentsync.DISPATCH_MODEL_ID,
      promptPrefix: '[sidequest-route model=gpt-5.6-terra effort=high]\n\n',
    });
    assert.equal(recipe.effortCarrier, 'marker');
    assert.deepEqual(recipe.warnings, []);

    store.setCategory({ id: 'recipe-disabled', name: 'Recipe Disabled', route: { model: 'sonnet', effort: 'high' }, enabled: false });
    const disabled = callToolRaw('route_recipe', { category: 'recipe-disabled' });
    assert.ok(disabled.isError);
    assert.match(disabled.content[0].text, /disabled for this project/i);

    const unknown = callToolRaw('route_recipe', { category: 'missing-recipe' });
    assert.ok(unknown.isError);
    assert.match(unknown.content[0].text, /unknown/i);

    const resolveCategoryRoute = store.resolveCategoryRoute;
    store.resolveCategoryRoute = () => ({ exec: null });
    try {
      const unroutable = callToolRaw('route_recipe', { category: 'recipe-codex' });
      assert.ok(unroutable.isError);
      assert.match(unroutable.content[0].text, /no available route/i);
    } finally {
      store.resolveCategoryRoute = resolveCategoryRoute;
    }
  } finally {
    clearCatalog();
  }
});

test('done stamps workedBy with a discovered Codex slug', () => {
  seedCatalog([{ slug: 'codex-terra', id: 'claude-codex-gpt-5.6-terra[1m]' }]);
  try {
    store.setCategory({ id: 'provenance-codex', name: 'Provenance Codex', route: { model: 'codex-terra', effort: 'high' } });
    const added = callTool('add', { title: 'codex provenance', category: 'provenance-codex' });
    const ref = added.ref;
    callTool('claim', { ref, by: 'mcp-w-codex' });
    const done = callTool('done', { ref, by: 'mcp-w-codex', model: 'codex-terra', effort: 'high' });
    assert.strictEqual(done.ok, true);
    assert.strictEqual(done.workedBy.model, 'codex-terra');
  } finally {
    clearCatalog();
  }
});

test('ready with an unrecognized model errors instead of silently meaning "no filter"', () => {
  const res = callToolRaw('ready', { model: 'totally-bogus-tier' });
  assert.ok(res.isError, 'an unrecognized model filter is refused, not silently ignored');
  assert.match(res.content[0].text, /unknown model/i);
  assert.match(res.content[0].text, /totally-bogus-tier/, 'names the offending value');
});

test('claim guard refusal names the Codex-backed executor for a concrete route', () => {
  seedCatalog([{ slug: 'codex-terra', id: 'claude-codex-gpt-5.6-terra[1m]' }]);
  try {
    store.setCategory({ id: 'guard-codex', name: 'Guard Codex', route: { model: 'codex-terra', effort: 'high' } });
    const added = callTool('add', { title: 'codex guard', category: 'guard-codex' });
    const wrong = store.VALID_EFFORTS.find((effort) => effort !== store.getTicket(added.project, added.ref).effort);
    const res = callTool('claim', { ref: added.ref, by: 'mcp-w-guard', effort: wrong });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'effort_mismatch');
    assert.match(res.message, new RegExp(`sidequest-exec-dispatch-${store.getTicket(added.project, added.ref).effort}`));
  } finally {
    clearCatalog();
  }
});

/* ------------------------------------------------------------------ *
 *  SQ-228: the default MCP `list` is PAGED so a large board cannot
 *  overflow the tool-result token cap. SQ-220 made each ROW compact but
 *  not the row COUNT, so a few-hundred-ticket column still overflowed
 *  (98k chars observed live). Now each call returns a bounded page +
 *  total + returned + nextCursor; following nextCursor walks the whole
 *  board one safe page at a time. all:true / limit:N are the escapes.
 * ------------------------------------------------------------------ */

// The pretty serialization the RPC layer emits for a tool result — the exact
// string that hits the tool-result cap, so it's what a page is proven against.
function resultChars(name, args) {
  const resp = mcp.handleRequest({ jsonrpc: '2.0', id: ++idc, method: 'tools/call', params: { name, arguments: args || {} } });
  return resp.result.content[0].text.length;
}

test('SQ-228: a large board pages under the cap; cursors iterate the full set exactly once', () => {
  // A dedicated board so seeding 500 tickets can't perturb the shared-board
  // tests above. Every call passes project explicitly.
  const big = store.ensureProject(path.join(os.tmpdir(), 'sq-mcp-bigboard-228'), 'SQ-228 Big Board');
  const N = 500;
  for (let i = 0; i < N; i++) {
    store.createTicket(big.slug, { title: `bulk todo ticket number ${i} on the oversized board`, files: [`lib/mod-${i}.js`] });
  }

  // all:true is the escape hatch — the whole column in one call, and (this is the
  // bug) it serializes far past the tool-result ceiling. total/returned agree.
  const allRes = callTool('list', { project: big.slug, all: true });
  assert.strictEqual(allRes.total, N, 'all:true reports the true total');
  assert.strictEqual(allRes.returned, N, 'all:true returns every ticket');
  assert.strictEqual(allRes.tickets.length, N, 'all 500 present under all:true');
  assert.strictEqual(allRes.nextCursor, null, 'all:true has no next page');
  const allChars = resultChars('list', { project: big.slug, all: true });
  assert.ok(allChars > 100000, `unbounded all:true overflows (${allChars} chars) — reproduces the bug`);

  // Page 1 (default): bounded well under the ceiling, reports the true total, and
  // hands back a cursor because there's more.
  const p1 = callTool('list', { project: big.slug });
  assert.strictEqual(p1.total, N, 'page 1 reports the true total');
  assert.ok(p1.returned > 0 && p1.returned < N, 'page 1 is a partial page');
  assert.strictEqual(p1.tickets.length, p1.returned, 'returned matches the array length');
  assert.ok(p1.nextCursor, 'page 1 hands back a cursor');
  assert.match(p1.hint, /cursor/, 'the hint tells the caller to follow the cursor');
  const p1Chars = resultChars('list', { project: big.slug });
  assert.ok(p1Chars < 90000, `page 1 stays under the ceiling (${p1Chars} chars vs unbounded ${allChars})`);

  // Iterate the cursor to exhaustion: collect every ref, assert we saw all 500
  // exactly once, every page fit under the ceiling, and paging terminates.
  const seen = [];
  let cursor = undefined;
  let pages = 0;
  let maxPageChars = 0;
  do {
    const args = cursor === undefined ? { project: big.slug } : { project: big.slug, cursor };
    maxPageChars = Math.max(maxPageChars, resultChars('list', args));
    const page = callTool('list', args);
    for (const t of page.tickets) seen.push(t.ref);
    cursor = page.nextCursor;
    pages++;
    assert.ok(pages <= N + 5, 'paging terminates (no runaway loop)');
  } while (cursor);

  assert.ok(maxPageChars < 90000, `every page stayed under the ceiling (max ${maxPageChars} chars)`);
  assert.strictEqual(seen.length, N, 'iterating cursors yielded exactly N rows');
  assert.strictEqual(new Set(seen).size, N, 'every ticket appears exactly once (no dupes, no gaps)');
  assert.ok(pages >= 2, `a 500-ticket board takes several pages (took ${pages})`);

  // limit:N is an exact page size and its own cursor advances correctly.
  const capped = callTool('list', { project: big.slug, limit: 10 });
  assert.strictEqual(capped.returned, 10, 'limit:N returns exactly N');
  assert.strictEqual(capped.tickets.length, 10, 'exactly N rows');
  assert.strictEqual(capped.total, N, 'the true total rides alongside the page');
  assert.strictEqual(capped.nextCursor, '10', 'the cursor is the next offset');
  const capped2 = callTool('list', { project: big.slug, limit: 10, cursor: capped.nextCursor });
  assert.strictEqual(capped2.returned, 10, 'page 2 is also exactly N');
  assert.strictEqual(capped2.nextCursor, '20', 'page 2 advances the cursor to offset 20');
  assert.notStrictEqual(capped2.tickets[0].ref, capped.tickets[0].ref, 'page 2 starts past page 1');
  // The two limit-pages are disjoint and contiguous (no overlap, no gap).
  const p1Refs = new Set(capped.tickets.map((t) => t.ref));
  assert.ok(!capped2.tickets.some((t) => p1Refs.has(t.ref)), 'limit pages do not overlap');

  // A small board is a single call: no cursor, everything returned (backward
  // compatible). Brief row shape is untouched (SQ-220 parity).
  const small = store.ensureProject(path.join(os.tmpdir(), 'sq-mcp-smallboard-228'), 'SQ-228 Small Board');
  store.createTicket(small.slug, { title: 'the only ticket' });
  const smallList = callTool('list', { project: small.slug });
  assert.strictEqual(smallList.nextCursor, null, 'a small board fits in one page');
  assert.strictEqual(smallList.returned, smallList.tickets.length);
  assert.strictEqual(smallList.total, smallList.tickets.length);
  assert.strictEqual(smallList.hint, undefined, 'no paging hint when there is no next page');
});
