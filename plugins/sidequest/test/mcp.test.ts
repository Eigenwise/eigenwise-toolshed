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
fs.mkdirSync(PROJ, { recursive: true });
execFileSync('git', ['init', '--quiet'], { cwd: PROJ, windowsHide: true });
execFileSync('git', ['-c', 'user.name=Sidequest Tests', '-c', 'user.email=sidequest@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'fixture'], { cwd: PROJ, windowsHide: true });
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
function writeCatalogRaw(dir?: any, body?: any) {
  fs.mkdirSync(path.join(dir, 'codex-gateway'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'codex-gateway', 'catalog.json'), body);
}
function seedCatalog(models?: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-catalog-'));
  writeCatalogRaw(dir, JSON.stringify({ schemaVersion: 3, source: 'codex-gateway', updatedAt: new Date().toISOString(), models }));
  process.env.SIDEQUEST_DISCOVERY_DIRS = dir;
  return dir;
}
function clearCatalog() {
  process.env.SIDEQUEST_DISCOVERY_DIRS = NO_CATALOG_DIR;
}
function committedRepo(prefix?: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '--quiet'], { cwd: root, windowsHide: true });
  execFileSync('git', ['-c', 'user.name=Sidequest Tests', '-c', 'user.email=sidequest@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'fixture'], { cwd: root, windowsHide: true });
  return root;
}

// Call a tool through the JSON-RPC surface and return the parsed result object
// (the text content decoded back to JSON), asserting it wasn't an error.
let idc = 0;
async function callTool(name?: any, args?: any) {
  const resp = await mcp.handleRequest({ jsonrpc: '2.0', id: ++idc, method: 'tools/call', params: { name, arguments: args || {} } });
  assert.ok(resp && resp.result, `tool ${name} returned a result`);
  assert.ok(!resp.result.isError, `tool ${name} errored: ${resp.result.content && resp.result.content[0] && resp.result.content[0].text}`);
  return JSON.parse(resp.result.content[0].text);
}
async function callToolRaw(name?: any, args?: any) {
  const resp = await mcp.handleRequest({ jsonrpc: '2.0', id: ++idc, method: 'tools/call', params: { name, arguments: args || {} } });
  return resp.result;
}
async function callToolOn(server?: any, name?: any, args?: any) {
  const resp = await server.handleRequest({ jsonrpc: '2.0', id: ++idc, method: 'tools/call', params: { name, arguments: args || {} } });
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
async function callHandler(name?: any, args?: any) {
  const tool = mcp.TOOLS.find((t: any) => t.name === name);
  assert.ok(tool, `tool ${name} exists in the registry`);
  return tool.handler(args || {});
}

function gitAt(cwd?: any, args?: any) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function runCli(args?: any, cwd?: any) {
  const cli = path.join(__dirname, '..', 'bin', 'sidequest.js');
  const output = execFileSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8', windowsHide: true,
    env: Object.assign({}, process.env, { SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: PROJ }),
  });
  const trimmed = output.trim();
  return trimmed && trimmed.startsWith('{') ? JSON.parse(trimmed) : trimmed;
}

function runForceBypass(payload?: any) {
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

function stageLongOutOfScopeChangeSet(worktree?: any) {
  fs.mkdirSync(path.join(worktree, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(worktree, 'lib', 'allowed.js'), 'allowed\n');
  const paths = Array.from({ length: 180 }, (_, index) => `foreign/${String(index).padStart(3, '0')}-${'x'.repeat(110)}.js`);
  for (const file of paths) {
    fs.mkdirSync(path.dirname(path.join(worktree, file)), { recursive: true });
    fs.writeFileSync(path.join(worktree, file), 'foreign\n');
  }
  gitAt(worktree, ['add', '.']);
  return paths;
}

test('initialize returns a protocol version, tools capability, and serverInfo', async () => {
  const resp = await mcp.handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.strictEqual(resp.result.protocolVersion, '2025-06-18', 'echoes the client-requested version');
  assert.ok(resp.result.capabilities.tools, 'advertises tools');
  assert.strictEqual(resp.result.serverInfo.name, 'sidequest');
});

test('notifications/initialized takes no response', async () => {
  const resp = await mcp.handleRequest({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.strictEqual(resp, null);
});

test('tools/list advertises the board tools with input schemas', async () => {
  const resp = await mcp.handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = resp.result.tools.map((t: any) => t.name);
  for (const expected of ['list', 'ready', 'add', 'update', 'remove', 'archive', 'unarchive', 'claim', 'sweepClaims', 'next', 'done', 'groomClose', 'release', 'commit', 'submit', 'comment', 'link', 'unlink', 'assign', 'dispatch', 'story_contract', 'category_add', 'category_edit', 'category_rm', 'category_detach', 'category_relink', 'category_list', 'global_fallback', 'board_config', 'models', 'projects', 'archive_board', 'unarchive_board', 'route_recipe']) {
    assert.ok(names.includes(expected), `exposes ${expected}`);
  }
  for (const cliOnly of ['native_agent', 'native_agent_cleanup']) {
    assert.ok(!names.includes(cliOnly), `${cliOnly} stays CLI-only`);
  }
  for (const t of resp.result.tools) {
    assert.strictEqual(t.inputSchema.type, 'object', `${t.name} has an object input schema`);
  }
  const submit = resp.result.tools.find((tool: any) => tool.name === 'submit');
  assert.ok(submit.inputSchema.properties.base, 'submit exposes an explicit base');
});

test('add and update preserve descriptions and expose storyId explicitly', async () => {
  const project = store.ensureProject(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-description-'))).slug;
  const story = store.createStory(project, { title: 'Description contract' });
  const description = 'Where: MCP add.\nContract: preserve this prose byte-for-byte.\nVerify: read the ticket.';
  const added = await callTool('add', { project, title: 'description persistence', description, storyId: story.ref, unclassified: true });
  let ticket = store.getTicket(project, added.ref);
  assert.equal(ticket.description, description);
  assert.equal(ticket.storyId, story.id);

  const updatedDescription = 'Where: MCP update.\nContract: keep every newline.\nVerify: inspect the returned ticket.';
  await callTool('update', { project, ref: added.ref, description: updatedDescription, storyId: 'none' });
  ticket = store.getTicket(project, added.ref);
  assert.equal(ticket.description, updatedDescription);
  assert.equal(ticket.storyId, null);

  const tools = mcp.toolDescriptors();
  for (const name of ['add', 'update']) {
    const properties = tools.find((tool: any) => tool.name === name).inputSchema.properties;
    assert.ok(properties.description, `${name} exposes description`);
    assert.ok(properties.storyId, `${name} exposes storyId`);
    assert.equal(properties.story, undefined, `${name} does not overload story`);
  }
  assert.equal(tools.find((tool: any) => tool.name === 'add').inputSchema.properties.storyId.pattern, '^US-\\d+$');
});

test('storyId rejects values outside the US-n format', async () => {
  const project = store.ensureProject(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-story-id-'))).slug;
  const response = await mcp.handleRequest({
    jsonrpc: '2.0', id: ++idc, method: 'tools/call',
    params: { name: 'add', arguments: { project, title: 'invalid story ID', storyId: 'story prose', unclassified: true } },
  });
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /storyId must be a US-n story ref/);
});

test('story contracts are bounded, revisioned, and warn claimed members about drift', async () => {
  const project = store.ensureProject(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-story-contract-'))).slug;
  const story = store.createStory(project, { title: 'Contract packet' });
  const ticket = store.createTicket(project, { title: 'Member ticket', storyId: story.ref, source: 'test' });
  assert.equal(store.claimTicket(project, ticket.ref, 'contract-worker', { direct: true }).ok, true);

  const set = await callTool('story_contract', { project, story: story.ref, contract: 'Decision: preserve briefing order.\nInvariant: no silent rebrief.' });
  assert.equal(set.story.contractRevision, 1);
  const read = await callTool('story_contract', { project, story: story.ref });
  assert.equal(read.story.executionContract, set.story.executionContract);
  assert.throws(
    () => store.updateStory(project, story.ref, { executionContract: '測'.repeat(2000) }),
    /4096-byte limit/,
  );

  const pulse = await callTool('pulse', { project, ref: ticket.ref });
  assert.match(pulse.warnings.join('\n'), /execution contract changed from revision 0 to 1/);
  const changes = await callTool('changes', { project, since: '2000-01-01T00:00:00.000Z' });
  assert.match(changes.tickets.find((entry: any) => entry.ref === ticket.ref).warnings.join('\n'), /execution contract changed/);
});

test('tools/list keeps schemas compact without losing claim and dispatch discipline', async () => {
  const tools = mcp.toolDescriptors();
  const descriptionBytes = (value: any): number => {
    if (Array.isArray(value)) return value.reduce((total, entry) => total + descriptionBytes(entry), 0);
    if (!value || typeof value !== 'object') return 0;
    return Object.entries(value).reduce((total, [key, entry]) =>
      total + (key === 'description' && typeof entry === 'string' ? Buffer.byteLength(entry) : descriptionBytes(entry)), 0);
  };
  const total = descriptionBytes(tools);
  assert.ok(total <= 5000, `tool descriptions use ${total} bytes — trim them, don't raise the budget`);
  const payload = JSON.stringify({ tools });
  assert.ok(payload.length <= 15500, `tools/list payload is ${payload.length} bytes — trim schemas, don't raise the budget`);
  assert.match(tools.find((tool: any) => tool.name === 'claim').description, /ok:true/);
  assert.match(tools.find((tool: any) => tool.name === 'dispatch').description, /stable route/);
  assert.match(tools.find((tool: any) => tool.name === 'done').description, /actual model and effort/);
  assert.match(tools.find((tool: any) => tool.name === 'list').description, /^For liveness\/progress polling use changes\/pulse, not this\./);
  const list = tools.find((tool: any) => tool.name === 'list');
  assert.match(list.inputSchema.properties.detail.description, /^Audit only:/);
  assert.match(list.inputSchema.properties.detail.description, /liveness uses changes\/pulse/);
  assert.match(tools.find((tool: any) => tool.name === 'comments').description, /^Read ticket comments before work; full history is chronological/);
  const comments = tools.find((tool: any) => tool.name === 'comments');
  assert.match(comments.inputSchema.properties.full.description, /^Recovery read:/);
  assert.match(comments.inputSchema.properties.full.description, /1200 chars\/body/);
  const add = tools.find((tool: any) => tool.name === 'add');
  assert.match(add.inputSchema.properties.complexity.description, /Requires why \(min 20 chars\)/);
  assert.match(tools.find((tool: any) => tool.name === 'changes').description, /^THE polling read/);
  assert.deepEqual(Object.keys(comments.inputSchema.properties).sort(), ['cursor', 'full', 'limit', 'project', 'ref']);
  assert.equal(comments.inputSchema.properties.full.type, 'boolean');
  assert.equal(Object.hasOwn(tools.find((tool: any) => tool.name === 'unarchive').inputSchema.properties, 'full'), false);
  for (const tool of tools) {
    const source = mcp.TOOLS.find((candidate: any) => candidate.name === tool.name);
    assert.deepEqual(
      Object.keys(tool.inputSchema.properties).sort(),
      Object.keys(source.inputSchema.properties).sort(),
      `${tool.name} preserves every input property`,
    );
  }
});

test('board_config defaults docs to always-in-scope', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-docs-scope-'));
  fs.mkdirSync(path.join(root, 'docs'));
  const project = store.ensureProject(root, 'SQ docs config').slug;
  assert.deepEqual((await callTool('board_config', { project })).alwaysInScope, ['docs/']);
});


test('board_config reads and replaces always-in-scope paths', async () => {
  const project = store.ensureProject(path.join(os.tmpdir(), 'sq-mcp-board-config'), 'SQ config').slug;
  const configured = await callTool('board_config', { project, alwaysInScope: ['docs', 'notes'] });
  assert.deepEqual(configured.alwaysInScope, ['docs', 'notes']);
  assert.deepEqual((await callTool('board_config', { project })).alwaysInScope, ['docs', 'notes']);
});

test('board_config renames only a board display name', async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-board-rename-'));
  const project = store.ensureProject(projectPath, 'Original board').slug;
  const ticket = store.createTicket(project, {
    title: 'rename keeps ticket refs', complexity: 2,
    complexityWhy: 'The display name changes while the stable ticket reference remains intact.',
  });
  const before = store.readMeta(project);
  const renamed = await callTool('board_config', { project, name: 'Renamed board' });

  assert.equal(renamed.name, 'Renamed board');
  assert.equal(renamed.projectName, 'Renamed board');
  assert.equal(store.readMeta(project).path, before.path);
  assert.equal(store.findProject(project).slug, project);
  assert.equal(store.getTicket(project, ticket.ref).ref, ticket.ref);

  const duplicate = store.ensureProject(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-duplicate-name-')), 'Renamed board').slug;
  assert.equal((await callTool('board_config', { project: duplicate, name: 'Renamed board' })).name, 'Renamed board');

  const rejected = await callToolRaw('board_config', { project, name: '   ' });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /Board name cannot be empty/);
});

test('board_config stores and clears a worktree setup command', async () => {
  const project = store.ensureProject(path.join(os.tmpdir(), 'sq-mcp-worktree-setup'), 'SQ worktree setup').slug;
  const setup = 'cd plugins/sidequest && npm ci';
  assert.equal((await callTool('board_config', { project, worktreeSetup: setup })).worktreeSetup, setup);
  assert.equal((await callTool('board_config', { project })).worktreeSetup, setup);
  assert.equal((await callTool('board_config', { project, worktreeSetup: null })).worktreeSetup, null);
});


test('write acks and pulse stay lean: no body echoes, no lifecycle noise by default', async () => {
  const project = store.ensureProject(path.join(os.tmpdir(), 'sq-mcp-lean-shapes'), 'SQ lean shapes').slug;
  const ticket = store.createTicket(project, {
    title: 'lean wire shapes', complexity: 2, complexityWhy: 'exercise ack and pulse response shapes',
  });

  const body = 'A long durable handoff body that must never ride back in the ack.\n'.repeat(5);
  const ack = await callTool('comment', { project, ref: ticket.ref, body, by: 'shape-tester' });
  assert.equal(ack.ok, true);
  assert.ok(ack.commentId, 'ack carries the comment id');
  assert.ok(ack.at, 'ack carries the timestamp');
  assert.equal(ack.comment, undefined, 'ack must not echo the comment object');
  assert.ok(!JSON.stringify(ack).includes('durable handoff body'), 'ack must not echo the body text');


  store.prepareDispatch(project, ticket.ref, { sessionId: 'shape-session' });
  const pulse = await callTool('pulse', { project, ref: ticket.ref });
  assert.ok(pulse.dispatch, 'pulse still reports dispatch state');
  assert.ok(pulse.dispatch.state, 'slim dispatch keeps state');
  for (const noisy of ['sessionId', 'preparedAt', 'launchedAt', 'boundAt', 'claimedAt', 'terminalAt', 'terminalSource', 'agentId']) {
    assert.ok(!(noisy in pulse.dispatch), `slim pulse omits ${noisy}`);
  }
  const detailed = await callTool('pulse', { project, ref: ticket.ref, detail: true });
  assert.ok('preparedAt' in detailed.dispatch, 'detail:true restores the full dispatch lifecycle');
});

test('MCP defaults cap category, dispatch, and pulse result payloads', async () => {
  const project = store.ensureProject(path.join(os.tmpdir(), 'sq-mcp-payload-budget-')).slug;
  for (let index = 0; index < 18; index += 1) {
    const id = `payload-${index}`;
    store.setProjectCategory(project, id, 'ADD', {
      id,
      name: `Payload category ${index}`,
      description: `Classify work that changes the payload fixture ${index}. `.repeat(3),
      contract: `Full contract ${index}. `.repeat(10),
      route: { model: 'sonnet', effort: 'low' },
      fallback: null,
      enabled: true,
    });
  }

  const categories = await callToolRaw('category_list', { project });
  assert.ok(Buffer.byteLength(categories.content[0].text) <= 13000, `category_list is ${Buffer.byteLength(categories.content[0].text)} bytes`);
  const categoryPayload = JSON.parse(categories.content[0].text);
  assert.ok(categoryPayload.total >= 18);
  assert.equal(categoryPayload.returned, categoryPayload.categories.length);
  const localCategory = categoryPayload.categories.find((category: any) => category.id === 'payload-0');
  assert.equal(localCategory.localRow, undefined);
  assert.equal(localCategory.route, undefined);
  const fullCategories = await callTool('category_list', { project, full: true });
  assert.equal(fullCategories.categories.find((category: any) => category.id === 'payload-0').localRow.data, undefined);

  const ticket = await callTool('add', { project, title: 'payload dispatch', description: DISPATCH_DESCRIPTION, category: 'payload-0' });
  const dispatched = await callToolRaw('dispatch', { project, ref: ticket.ref });
  assert.ok(Buffer.byteLength(dispatched.content[0].text) <= 1200, `dispatch is ${Buffer.byteLength(dispatched.content[0].text)} bytes`);
  const dispatchPayload = JSON.parse(dispatched.content[0].text);
  assert.deepStrictEqual(Object.keys(dispatchPayload).sort(), ['effort', 'ref', 'runsLabel', 'spawn']);
  assert.equal(dispatchPayload.token, undefined);
  assert.equal(dispatchPayload.agent, undefined);
  assert.equal(dispatchPayload.guidance, undefined);

  const warningTicket = await callTool('add', { project, title: 'payload warning', description: DISPATCH_DESCRIPTION, category: 'debugging' });
  const warningDispatch = await callToolRaw('dispatch', { project, ref: warningTicket.ref });
  assert.ok(Buffer.byteLength(warningDispatch.content[0].text) <= 1200, `warning dispatch is ${Buffer.byteLength(warningDispatch.content[0].text)} bytes`);
  assert.deepStrictEqual(JSON.parse(warningDispatch.content[0].text).warnings, ['Dispatch warning: this coding/debugging ticket has no verify command. Add one before the executor starts.']);

  const pulse = await callToolRaw('pulse', { project, ref: ticket.ref });
  assert.ok(Buffer.byteLength(pulse.content[0].text) <= 1200, `pulse is ${Buffer.byteLength(pulse.content[0].text)} bytes`);
  const pulsePayload = JSON.parse(pulse.content[0].text);
  assert.equal(pulsePayload.submission, undefined);
  assert.equal(pulsePayload.git, undefined);
  assert.equal(pulsePayload.dispatch.tokenPrefix, undefined);
});

test('dispatch warns about declared scopes held by in-flight tickets', async () => {
  const project = store.ensureProject(committedRepo('sq-mcp-dispatch-overlap-')).slug;
  const inFlight = await callTool('add', {
    project,
    title: 'in-flight scope',
    description: DISPATCH_DESCRIPTION,
    category: 'general',
    files: ['src'],
  });
  const prepared = store.prepareDispatch(project, inFlight.ref);
  assert.equal(store.claimTicket(project, inFlight.ref, 'overlap-worker', {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);
  const target = await callTool('add', {
    project,
    title: 'overlapping scope',
    description: DISPATCH_DESCRIPTION,
    category: 'general',
    files: ['src/lib.rs'],
  });

  const dispatched = await callTool('dispatch', { project, ref: target.ref, full: true });
  assert.deepEqual(dispatched.warnings, [
    `Dispatch warning: ${target.ref} overlaps in-flight ${inFlight.ref} at src/lib.rs.`,
  ]);
});

test('dispatch identifies lockfile-only scope overlaps', async () => {
  const project = store.ensureProject(committedRepo('sq-mcp-lockfile-overlap-')).slug;
  const inFlight = await callTool('add', {
    project,
    title: 'in-flight lockfile',
    description: DISPATCH_DESCRIPTION,
    category: 'general',
    files: ['Cargo.lock'],
  });
  store.prepareDispatch(project, inFlight.ref);
  const target = await callTool('add', {
    project,
    title: 'overlapping lockfile',
    description: DISPATCH_DESCRIPTION,
    category: 'general',
    files: ['Cargo.lock'],
  });

  const dispatched = await callTool('dispatch', { project, ref: target.ref, full: true });
  assert.deepEqual(dispatched.warnings, [
    `Dispatch warning: ${target.ref} overlaps in-flight ${inFlight.ref} at Cargo.lock. Only lockfiles overlap; serialize these tickets or regenerate the lockfile at integration.`,
  ]);
});

test('compact pulse bounds latest comment bodies and list rows omit ticket bodies', async () => {
  const project = store.ensureProject(path.join(os.tmpdir(), 'sq-mcp-compact-pulse-body-')).slug;
  const body = `latest comment body: ${'x'.repeat(6000)}`;
  const ticket = store.createTicket(project, {
    title: 'compact pulse body',
    description: `ticket description: ${'y'.repeat(6000)}`,
  });
  assert.equal(store.addComment(project, ticket.ref, { body, by: 'payload-tester', kind: 'comment', source: 'mcp' }).ok, true);

  const originalPulsePayload = store.pulsePayload;
  store.pulsePayload = (slug: any, ref: any) => {
    const payload = originalPulsePayload(slug, ref);
    return Object.assign({}, payload, {
      lastComment: Object.assign({}, payload.lastComment, { body }),
    });
  };
  try {
    const raw = await callToolRaw('pulse', { project, ref: ticket.ref });
    const compact = JSON.parse(raw.content[0].text);
    assert.ok(Buffer.byteLength(raw.content[0].text) < 1000, `compact pulse is ${Buffer.byteLength(raw.content[0].text)} bytes`);
    assert.ok(compact.lastComment.body.length <= 280);
    assert.match(compact.lastComment.body, /use full:true/);

    const full = await callTool('pulse', { project, ref: ticket.ref, full: true });
    assert.equal(full.lastComment.body, body);
  } finally {
    store.pulsePayload = originalPulsePayload;
  }

  const list = await callToolRaw('list', { project });
  const row = JSON.parse(list.content[0].text).tickets.find((candidate: any) => candidate.ref === ticket.ref);
  assert.equal(row.description, undefined);
  assert.equal(row.lastComment, undefined);
  assert.equal(row.comments, 1);
  assert.ok(!list.content[0].text.includes('ticket description:'), 'compact list rows omit ticket descriptions');
  assert.ok(!list.content[0].text.includes('latest comment body:'), 'compact list rows omit comment bodies');
});

test('compact category pages stay bounded and recover complete taxonomy rows', async (t: any) => {
  const root = path.join(os.tmpdir(), 'sq-mcp-category-pages');
  const project = store.ensureProject(root, 'SQ category pages').slug;
  const expectedDescriptions = new Map();
  for (let index = 0; index < 21; index += 1) {
    const id = `bounded-${String(index).padStart(2, '0')}`;
    const prefix = `Classification contract ${index}: `;
    const description = prefix + String(index % 10).repeat(16000 - prefix.length);
    expectedDescriptions.set(id, description);
    store.setProjectCategory(project, id, 'ADD', {
      id,
      name: `Bounded category ${String(index).padStart(2, '0')}`,
      description,
      contract: `Executor contract ${index}`,
      route: { model: 'sonnet', effort: 'low' },
      fallback: null,
      enabled: true,
    });
  }

  const compactIds: string[] = [];
  const pageBytes: number[] = [];
  let cursor: string | undefined;
  let compactPages = 0;
  do {
    const raw = await callToolRaw('category_list', { project, ...(cursor ? { cursor } : {}) });
    const bytes = Buffer.byteLength(raw.content[0].text);
    pageBytes.push(bytes);
    assert.ok(bytes <= 13000, `compact category page is ${bytes} bytes`);
    const page = JSON.parse(raw.content[0].text);
    assert.equal(page.returned, page.categories.length);
    for (const category of page.categories) {
      compactIds.push(category.id);
      if (expectedDescriptions.has(category.id)) {
        assert.equal(category.descriptionLength, 16000);
        assert.equal(category.descriptionTruncated, true);
        assert.match(category.description, /use full:true/);
      }
    }
    cursor = page.nextCursor || undefined;
    compactPages += 1;
  } while (cursor);
  assert.ok(compactPages > 1);
  assert.equal(new Set(compactIds).size, compactIds.length);
  assert.deepEqual([...expectedDescriptions.keys()].filter((id) => !compactIds.includes(id)), []);
  t.diagnostic(`category_list: ${compactIds.length} rows across ${compactPages} pages, max ${Math.max(...pageBytes)} bytes`);

  const recovered = new Map();
  cursor = undefined;
  do {
    const page = await callTool('category_list', { project, full: true, limit: 4, ...(cursor ? { cursor } : {}) });
    for (const category of page.categories) {
      if (expectedDescriptions.has(category.id)) recovered.set(category.id, category.description);
    }
    cursor = page.nextCursor || undefined;
  } while (cursor);
  assert.deepEqual(recovered, expectedDescriptions);

  const legacyFull = await callTool('category_list', { project, full: true });
  assert.equal(Object.hasOwn(legacyFull, 'nextCursor'), false);
  assert.equal(legacyFull.categories.find((category: any) => category.id === 'bounded-00').description, expectedDescriptions.get('bounded-00'));
  const cliCategories = runCli(['category', 'list', '--project', project, '--json']);
  assert.deepEqual(Object.keys(cliCategories).sort(), ['categories', 'localRowCount', 'profile', 'project', 'projectName', 'warnings']);
  assert.equal(cliCategories.categories.find((category: any) => category.id === 'bounded-00').description, expectedDescriptions.get('bounded-00'));

  for (const args of [{ cursor: 'bad' }, { cursor: '-1' }, { limit: 0 }, { limit: 101 }]) {
    const invalid = await callToolRaw('category_list', { project, ...args });
    assert.equal(invalid.isError, true);
  }
  const pastEnd = await callToolRaw('category_list', { project, cursor: '9999' });
  assert.equal(pastEnd.isError, true);
});

test('comment reads stay chronological through the ten-comment threshold', async (t: any) => {
  const root = path.join(os.tmpdir(), 'sq-mcp-comment-pages');
  const project = store.ensureProject(root, 'SQ comment pages').slug;
  const ticket = store.createTicket(project, {
    title: 'bounded comments',
    description: DISPATCH_DESCRIPTION,
    complexity: 2,
    complexityWhy: 'exercise bounded comment reads and complete executor briefing recovery',
  });

  const empty = await callTool('comments', { project, ref: ticket.ref });
  assert.deepEqual(empty.comments, []);
  assert.deepEqual({ total: empty.total, returned: empty.returned, nextCursor: empty.nextCursor }, { total: 0, returned: 0, nextCursor: null });

  const bodies: string[] = [];
  for (let index = 0; index < 8; index += 1) {
    const prefix = `comment-${index}:`;
    const body = prefix + String(index).repeat(16000 - prefix.length);
    bodies.push(body);
    assert.equal(store.addComment(project, ticket.ref, { body, by: `worker-${index}`, kind: 'comment', source: 'mcp' }).ok, true);
  }

  const defaultRaw = await callToolRaw('comments', { project, ref: ticket.ref });
  const defaultBytes = Buffer.byteLength(defaultRaw.content[0].text);
  const defaultRead = JSON.parse(defaultRaw.content[0].text);
  assert.equal(defaultRead.total, 8);
  assert.equal(defaultRead.returned, 8);
  assert.equal(defaultRead.order, 'chronological');
  assert.equal(defaultRead.comments[0].bodyLength, 16000);
  assert.equal(defaultRead.comments[0].bodyTruncated, true);
  assert.match(defaultRead.comments[0].body, /^comment-0:/);
  assert.equal(defaultRead.comments[0].source, undefined);
  assert.equal(Object.hasOwn(defaultRead, 'notice'), false);
  t.diagnostic(`comments: ${defaultRead.returned}/${defaultRead.total} exact rows in ${defaultBytes} bytes`);

  const recovered: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await callTool('comments', { project, ref: ticket.ref, full: true, limit: 2, ...(cursor ? { cursor } : {}) });
    assert.equal(page.order, 'chronological');
    recovered.push(...page.comments.map((comment: any) => comment.body));
    cursor = page.nextCursor || undefined;
  } while (cursor);
  assert.deepEqual(recovered, bodies);

  const legacyFull = await callTool('comments', { project, ref: ticket.ref, full: true });
  assert.equal(Object.hasOwn(legacyFull, 'nextCursor'), false);
  assert.deepEqual(legacyFull.comments.map((comment: any) => comment.body), bodies);
  assert.equal(legacyFull.comments[0].source, 'mcp');
  const cliComments = runCli(['comments', ticket.ref, '--project', project, '--json']);
  assert.deepEqual(Object.keys(cliComments).sort(), ['comments', 'project', 'ticket']);
  assert.deepEqual(cliComments.comments.map((comment: any) => comment.body), bodies);

  const prepared = store.prepareDispatch(project, ticket.ref, { sessionId: 'complete-comment-briefing' });
  const briefing = runCli(['briefing', ticket.ref, '--token', prepared.token, '--project', project]);
  const completePacket = agentsync.ticketCommentsPacket(store.getTicket(project, ticket.ref).comments);
  assert.ok(Buffer.byteLength(completePacket) <= 6 * 1024, `briefing packet is ${Buffer.byteLength(completePacket)} bytes`);
  assert.ok(briefing.includes(completePacket));
  assert.match(briefing, /Comment packet truncated/);
  assert.match(briefing, /compact comments reads \(latest-first\)/);
  assert.match(briefing, /comment-7:/);
  assert.ok(briefing.indexOf('comment-7:') < briefing.indexOf('comment-6:'));
  assert.doesNotMatch(briefing, new RegExp(`comment-0: y{${bodies[0]!.length - 1000}}`));

  for (const args of [{ cursor: 'bad' }, { cursor: '-1' }, { limit: 0 }, { limit: 101 }]) {
    const invalid = await callToolRaw('comments', { project, ref: ticket.ref, ...args });
    assert.equal(invalid.isError, true);
  }
  const pastEnd = await callToolRaw('comments', { project, ref: ticket.ref, cursor: '9' });
  assert.equal(pastEnd.isError, true);
});

test('comment reads elide only oldest bodies past ten and full bypasses elision', async () => {
  const root = path.join(os.tmpdir(), 'sq-mcp-comment-elision');
  const project = store.ensureProject(root, 'SQ comment elision').slug;
  const ticket = store.createTicket(project, { title: 'comment body elision' });
  const bodies = Array.from({ length: 12 }, (_, index) => `body-${index}`);
  for (let index = 0; index < bodies.length; index += 1) {
    assert.equal(store.addComment(project, ticket.ref, {
      body: bodies[index],
      by: `worker-${index}`,
      kind: index === 0 ? 'risk' : 'comment',
      source: 'mcp',
    }).ok, true);
  }

  const defaultRead = await callTool('comments', { project, ref: ticket.ref });
  assert.equal(defaultRead.order, 'chronological');
  assert.equal(defaultRead.total, 12);
  assert.equal(defaultRead.returned, 12);
  assert.equal(defaultRead.omittedBodies, 2);
  assert.equal(defaultRead.notice, '2 earlier comment bodies omitted — pass --full to see them.');
  assert.deepEqual(
    defaultRead.comments.slice(0, 2).map((comment: any) => ({ by: comment.by, kind: comment.kind, bodyOmitted: comment.bodyOmitted, hasBody: Object.hasOwn(comment, 'body') })),
    [
      { by: 'worker-0', kind: 'comment', bodyOmitted: true, hasBody: false },
      { by: 'worker-1', kind: 'comment', bodyOmitted: true, hasBody: false },
    ],
  );
  assert.ok(defaultRead.comments[0].at);
  assert.deepEqual(defaultRead.comments.slice(2).map((comment: any) => comment.body), bodies.slice(2));

  const fullRead = await callTool('comments', { project, ref: ticket.ref, full: true });
  assert.deepEqual(fullRead.comments.map((comment: any) => comment.body), bodies);
  assert.equal(Object.hasOwn(fullRead, 'notice'), false);

  const cliDefault = runCli(['comments', ticket.ref, '--project', project, '--json']);
  assert.equal(cliDefault.notice, '2 earlier comment bodies omitted — pass --full to see them.');
  assert.deepEqual(cliDefault.comments.slice(2).map((comment: any) => comment.body), bodies.slice(2));
  const cliText = runCli(['comments', ticket.ref, '--project', project]);
  assert.match(cliText, /2 earlier comment bodies omitted — pass --full to see them\./);
  assert.match(cliText, /worker-0 \(comment\): \[body omitted\]/);
  const cliFull = runCli(['comments', ticket.ref, '--project', project, '--json', '--full']);
  assert.deepEqual(Object.keys(cliFull).sort(), ['comments', 'project', 'ticket']);
  assert.deepEqual(cliFull.comments.map((comment: any) => comment.body), bodies);
});

test('MCP comment reads do not track per-session polling state and changes includes bounded excerpts', async () => {
  const project = store.ensureProject(path.join(os.tmpdir(), 'sq-mcp-polling-diet-')).slug;
  const ticket = store.createTicket(project, { title: 'polling diet fixture' });
  const body = `latest progress: ${'x'.repeat(500)}`;
  const since = new Date(Date.now() - 1000).toISOString();
  assert.equal(store.addComment(project, ticket.ref, { body, by: 'polling-worker', kind: 'comment', source: 'mcp' }).ok, true);

  const first = await callTool('comments', { project, ref: ticket.ref });
  const second = await callTool('comments', { project, ref: ticket.ref });
  assert.deepEqual(second, first);
  assert.equal(second.hint, undefined);

  const changes = await callTool('changes', { project, since });
  const changed = changes.tickets.find((entry: any) => entry.ref === ticket.ref);
  assert.deepEqual(changed.lastComment, {
    by: 'polling-worker',
    kind: 'comment',
    body: changed.lastComment.body,
    bodyLength: body.length,
    bodyTruncated: true,
  });
  assert.ok(changed.lastComment.body.length <= 200);
  assert.match(changed.lastComment.body, /use full:true/);
});

test('MCP commit and submit finish an isolated worktree without a PATH command', async () => {
  const worktree = createGitWorktree();
  const project = store.ensureProject(worktree).slug;
  const ticket = store.createTicket(project, {
    title: 'MCP terminal lifecycle', files: ['lib/allowed.js'], complexity: 3,
    labels: ['direct-ok'],
    complexityWhy: 'exercise the MCP commit and submit terminal worktree lifecycle',
  });
  const by = 'mcp-worktree-worker';
  assert.equal((await callTool('claim', { project, ref: ticket.ref, by, direct: true, reason: 'The MCP worktree fixture requires a local direct claim.' })).ok, true);

  fs.mkdirSync(path.join(worktree, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(worktree, 'lib', 'allowed.js'), 'allowed\n');
  fs.writeFileSync(path.join(worktree, 'foreign.js'), 'foreign\n');
  gitAt(worktree, ['add', '.']);
  const explicitPath = process.platform === 'win32' ? worktree.replace(/\//g, '\\') : worktree;
  const committed = await callTool('commit', {
    project, ref: ticket.ref, by, message: 'MCP scoped commit', worktree: explicitPath,
  });
  assert.ok(committed.commit, 'commit returns the local hash');
  assert.equal(committed.paths, undefined, 'commit acknowledgement omits echoed paths');
  assert.equal(gitAt(worktree, ['diff', '--cached', '--name-only']), 'foreign.js', 'foreign staging remains intact');
  gitAt(worktree, ['update-ref', `refs/sidequest/${ticket.ref}`, committed.commit]);

  const submitted = await callTool('submit', {
    project, ref: ticket.ref, by, commit: committed.commit,
    worktree: explicitPath, verify: 'node --test plugins/sidequest/test/mcp.test.js',
    body: 'MCP terminal evidence',
  });
  assert.equal(submitted.ok, true);
  assert.equal(submitted.submission, undefined, 'submit acknowledgement omits stored submission details');
  assert.equal(store.getTicket(project, ticket.ref).submission.commit, committed.commit);
  const after = store.getTicket(project, ticket.ref);
  assert.equal(after.claim, null, 'submit releases the claim');
  assert.ok(after.comments.some((comment: any) => comment.body === 'MCP terminal evidence'));

  const malformed = store.createTicket(project, {
    title: 'MCP malformed submission', files: ['lib/other.js'], complexity: 3,
    labels: ['direct-ok'],
    complexityWhy: 'confirm malformed MCP submission input preserves the ticket claim',
  });
  assert.equal((await callTool('claim', { project, ref: malformed.ref, by: 'mcp-bad-worker', direct: true, reason: 'The malformed submission fixture requires a direct claim.' })).ok, true);
  const bad = await callToolRaw('submit', { project, ref: malformed.ref, by: 'mcp-bad-worker', commit: 'not-a-hash', worktree });
  assert.ok(bad.isError, 'malformed hashes fail before a board write');
  assert.ok(store.getTicket(project, malformed.ref).claim, 'malformed submission keeps the claim');
});

test('MCP submit accepts a known submitted commit as an explicit base', async () => {
  const worktree = createGitWorktree();
  const project = store.ensureProject(worktree).slug;
  const first = store.createTicket(project, {
    title: 'MCP explicit base ancestor', files: ['lib/first.js'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'provide a validated submission boundary for a dependent range',
  });
  assert.equal((await callTool('claim', { project, ref: first.ref, by: 'mcp-base-worker', direct: true, reason: 'The MCP explicit-base fixture requires a local direct claim.' })).ok, true);
  fs.mkdirSync(path.join(worktree, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(worktree, 'lib', 'first.js'), 'first\n');
  gitAt(worktree, ['add', 'lib/first.js']);
  gitAt(worktree, ['commit', '-m', 'MCP explicit base ancestor']);
  const firstTip = gitAt(worktree, ['rev-parse', 'HEAD']);
  gitAt(worktree, ['update-ref', `refs/sidequest/${first.ref}`, firstTip]);
  assert.equal((await callTool('submit', { project, ref: first.ref, by: 'mcp-base-worker', commit: firstTip, worktree })).ok, true);

  const second = store.createTicket(project, {
    title: 'MCP explicit dependent range', files: ['lib/second.js'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'prove the MCP base input isolates the unsubmitted suffix',
  });
  assert.equal((await callTool('claim', { project, ref: second.ref, by: 'mcp-dependent-worker', direct: true, reason: 'The MCP explicit-base fixture requires a local direct claim.' })).ok, true);
  fs.writeFileSync(path.join(worktree, 'lib', 'second.js'), 'second\n');
  gitAt(worktree, ['add', 'lib/second.js']);
  gitAt(worktree, ['commit', '-m', 'MCP explicit dependent range']);
  const secondTip = gitAt(worktree, ['rev-parse', 'HEAD']);
  gitAt(worktree, ['update-ref', `refs/sidequest/${second.ref}`, secondTip]);

  const submitted = await callTool('submit', {
    project, ref: second.ref, by: 'mcp-dependent-worker', commit: secondTip, base: firstTip, worktree,
  });
  assert.equal(submitted.ok, true);
  const submission = store.getTicket(project, second.ref).submission;
  assert.equal(submission.base, firstTip);
  assert.deepEqual(submission.commits, [secondTip]);
  assert.deepEqual(submission.changedPaths, ['lib/second.js']);
});

test('MCP commit truncates out-of-scope comments and retains successful commits on comment failures', async () => {
  const worktree = createGitWorktree();
  const project = store.ensureProject(worktree).slug;
  const ticket = store.createTicket(project, {
    title: 'MCP out-of-scope warning', files: ['lib/allowed.js'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'exercise bounded MCP commit warnings',
  });
  const by = 'mcp-bounded-warning-worker';
  assert.equal((await callTool('claim', { project, ref: ticket.ref, by, direct: true, reason: 'The MCP warning fixture requires a local direct claim.' })).ok, true);
  const foreignPaths = stageLongOutOfScopeChangeSet(worktree);
  const committed = await callTool('commit', { project, ref: ticket.ref, by, message: 'MCP bounded warning', worktree });
  const comment = store.getTicket(project, ticket.ref).comments.at(-1);
  assert.ok(committed.commit, 'commit succeeds with long unscoped path lists');
  assert.ok(comment.body.length <= 16000, `comment is ${comment.body.length} characters`);
  assert.match(comment.body, /^out-of-scope changes present: foreign\/000-/);
  assert.match(comment.body, /… \+\d+ more \(run git status in the worktree for the full list\)$/);
  assert.equal(gitAt(worktree, ['diff', '--cached', '--name-only']).split('\n').length, foreignPaths.length);

  const failedCommentWorktree = createGitWorktree();
  const failedCommentProject = store.ensureProject(failedCommentWorktree).slug;
  const failedCommentTicket = store.createTicket(failedCommentProject, {
    title: 'MCP comment failure warning', files: ['lib/allowed.js'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'confirm comments cannot turn committed MCP work into a tool error',
  });
  const failedCommentBy = 'mcp-comment-failure-worker';
  assert.equal((await callTool('claim', { project: failedCommentProject, ref: failedCommentTicket.ref, by: failedCommentBy, direct: true, reason: 'The MCP comment failure fixture requires a local direct claim.' })).ok, true);
  fs.mkdirSync(path.join(failedCommentWorktree, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(failedCommentWorktree, 'lib', 'allowed.js'), 'allowed\n');
  fs.writeFileSync(path.join(failedCommentWorktree, 'foreign.js'), 'foreign\n');
  gitAt(failedCommentWorktree, ['add', '.']);
  const addComment = store.addComment;
  store.addComment = () => ({ ok: false, reason: 'too_long' });
  try {
    const warning = await callTool('commit', {
      project: failedCommentProject, ref: failedCommentTicket.ref, by: failedCommentBy,
      message: 'MCP comment failure warning', worktree: failedCommentWorktree,
    });
    assert.ok(warning.commit, 'the commit acknowledgement stays successful');
    assert.deepEqual(warning.warnings, ["out-of-scope paths weren't recorded: too_long"]);
  } finally {
    store.addComment = addComment;
  }
});

test('CLI commit truncates out-of-scope comments', async () => {
  const worktree = createGitWorktree();
  const project = store.ensureProject(worktree).slug;
  const ticket = store.createTicket(project, {
    title: 'CLI out-of-scope warning', files: ['lib/allowed.js'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'exercise bounded CLI commit warnings',
  });
  const by = 'cli-bounded-warning-worker';
  assert.equal((await callTool('claim', { project, ref: ticket.ref, by, direct: true, reason: 'The CLI warning fixture requires a local direct claim.' })).ok, true);
  stageLongOutOfScopeChangeSet(worktree);
  const committed = runCli(['commit', ticket.ref, '--project', project, '--by', by, '--message', 'CLI bounded warning', '--json'], worktree);
  const comment = store.getTicket(project, ticket.ref).comments.at(-1);
  assert.ok(committed.commit, 'CLI commit succeeds with long unscoped path lists');
  assert.equal(committed.warnings, undefined, 'a recorded warning does not add a failure warning');
  assert.ok(comment.body.length <= 16000, `comment is ${comment.body.length} characters`);
  assert.match(comment.body, /^out-of-scope changes present: foreign\/000-/);
  assert.match(comment.body, /… \+\d+ more \(run git status in the worktree for the full list\)$/);
});

test('MCP submit refuses out-of-scope committed ranges', async () => {
  const worktree = createGitWorktree();
  const project = store.ensureProject(worktree).slug;
  const ticket = store.createTicket(project, {
    title: 'MCP range scope refusal', files: ['lib/allowed.js'], complexity: 3,
    labels: ['direct-ok'],
    complexityWhy: 'confirm MCP submit refuses a committed range outside the declared scope',
  });
  const by = 'mcp-range-worker';
  assert.equal((await callTool('claim', { project, ref: ticket.ref, by, direct: true, reason: 'The MCP worktree fixture requires a local direct claim.' })).ok, true);
  fs.writeFileSync(path.join(worktree, 'foreign.js'), 'foreign\n');
  gitAt(worktree, ['add', 'foreign.js']);
  gitAt(worktree, ['commit', '-m', 'foreign work']);
  const commit = gitAt(worktree, ['rev-parse', 'HEAD']);
  gitAt(worktree, ['update-ref', `refs/sidequest/${ticket.ref}`, commit]);
  const refused = await callTool('submit', { project, ref: ticket.ref, by, commit, worktree });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'outside_scope');
  assert.match(refused.message, new RegExp(`sidequest update ${ticket.ref} --files`));
  assert.ok(store.getTicket(project, ticket.ref).claim, 'scope refusal keeps the claim');
});

test('MCP scopeRequest pauses a claimed executor until the orchestrator expands scope', async () => {
  const project = store.ensureProject(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-scope-request-'))).slug;
  const ticket = store.createTicket(project, {
    title: 'MCP scope request', files: ['lib/allowed.js'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'keep the executor claim while an orchestrator approves one new path',
  });
  const by = 'mcp-scope-request-worker';
  assert.equal((await callTool('claim', { project, ref: ticket.ref, by, direct: true, reason: 'The scope request fixture requires a local direct claim.' })).ok, true);

  const requested = await callTool('scopeRequest', { project, ref: ticket.ref, by, files: ['lib/new.js'] });
  assert.deepEqual(requested.scopeRequest.files, ['lib/new.js']);
  assert.equal(requested.command, `sidequest update ${ticket.ref} --files "lib/allowed.js,lib/new.js"`);
  assert.equal(store.getTicket(project, ticket.ref).claim.by, by, 'scope request keeps the executor claim');

  await callTool('update', { project, ref: ticket.ref, files: ['lib/allowed.js', 'lib/new.js'] });
  const approved = store.getTicket(project, ticket.ref);
  assert.equal(approved.claim.by, by, 'approval keeps the same executor runnable');
  assert.equal(approved.scopeRequest, null);
  assert.deepEqual(approved.files, ['lib/allowed.js', 'lib/new.js']);
});

test('sweepClaims releases stale claims through MCP', async () => {
  const created = await callTool('add', { title: 'MCP stale sweep', unclassified: true });
  const slug = created.project;
  assert.equal(store.claimTicket(slug, created.ref, 'mcp-stale').ok, true);
  const stale = store.getTicket(slug, created.ref);
  stale.claim.at = new Date(Date.now() - store.claimTtlMs() - 1).toISOString();
  const dbModule = require('../lib/db.js');
  dbModule.putRow(dbModule.openDb(SIDEQUEST_HOME), 'tickets', {
    id: stale.id, project: slug, ref: stale.ref, status: stale.status,
    archived: stale.archived ? 1 : 0, ord: stale.order, claim_by: stale.claim.by, data: stale,
  });
  const swept = await callTool('sweepClaims', { project: slug });
  assert.equal(swept.released.length, 1);
  assert.equal(store.getTicket(slug, created.ref).claim, null);
});


test('MCP board archive tools match the CLI archive-board lifecycle', async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-board-archive-'));
  const project = store.ensureProject(projectPath).slug;
  const cliArchived = runCli(['archive-board', project, '--json']);
  assert.equal(cliArchived.ok, true);
  assert.ok(store.findProject(project).meta.archivedAt);

  const restored = await callTool('unarchive_board', { project });
  assert.equal(restored.ok, true);
  assert.equal(store.findProject(project).meta.archivedAt, undefined);

  const archived = await callTool('archive_board', { project });
  assert.equal(archived.ok, true);
  assert.ok(store.findProject(project).meta.archivedAt);

  const cliRestored = runCli(['unarchive-board', project, '--json']);
  assert.equal(cliRestored.ok, true);
  assert.equal(store.findProject(project).meta.archivedAt, undefined);
});
test('dispatch returns a stable executor, one spawn prompt, and a token', async () => {
  const d = mcp.toolDescriptors().find((t: any) => t.name === 'dispatch');
  assert.ok(d);
  assert.deepStrictEqual(Object.keys(d.inputSchema.properties).sort(), ['full', 'project', 'ref', 'sharedTree']);
  assert.deepStrictEqual(d.inputSchema.required, ['ref']);

  seedCatalog([{ slug: 'codex-gpt-5-6-terra', id: 'claude-codex-gpt-5.6-terra', label: 'Terra' }]);
  store.setCategory({ id: 'dispatch-codex', name: 'Dispatch Codex', route: { model: 'codex-gpt-5-6-terra', effort: 'high' } });
  const slug = store.ensureProject(PROJ).slug;

  const addedInstant = await callTool('add', { title: 'instant dispatch', description: DISPATCH_DESCRIPTION, category: 'dispatch-codex' });
  const instant = await callTool('dispatch', { ref: addedInstant.ref, session: 'mcp-dispatch-session', full: true });
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

  const adopted = await callTool('dispatch', { ref: addedInstant.ref, session: 'adopting-session', full: true });
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

test('MCP dispatch records the runtime session and the Agent lifecycle binds it', async () => {
  const slug = store.ensureProject(PROJ).slug;
  store.setCategory({ id: 'mcp-runtime-session', name: 'MCP runtime session', route: { model: 'sonnet', effort: 'high' } });
  const friendly = await callTool('add', { title: 'friendly dispatch session', description: DISPATCH_DESCRIPTION, category: 'mcp-runtime-session' });
  const omitted = await callTool('add', { title: 'omitted dispatch session', description: DISPATCH_DESCRIPTION, category: 'mcp-runtime-session' });
  const real = await callTool('add', { title: 'runtime dispatch session', description: DISPATCH_DESCRIPTION, category: 'mcp-runtime-session' });

  const friendlyDispatch = await callTool('dispatch', { ref: friendly.ref, session: 'hh6-quant', full: true });
  await callTool('dispatch', { ref: omitted.ref });
  await callTool('dispatch', { ref: real.ref, session: MCP_SESSION_ID });

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
  let pulse = await callTool('pulse', { ref: friendly.ref, full: true });
  assert.equal(pulse.dispatch.state, 'launched');
  assert.equal(pulse.dispatch.sessionId, MCP_SESSION_ID);
  assert.ok(pulse.dispatch.launchedAt);

  assert.equal(store.bindDispatchAgent(MCP_SESSION_ID, friendlyDispatch.agent, 'native-mcp-session-agent', agentName).ok, true);
  pulse = await callTool('pulse', { ref: friendly.ref, full: true });
  assert.equal(pulse.dispatch.state, 'bound');
  assert.equal(pulse.dispatch.agentId, 'native-mcp-session-agent');
});

test('MCP dispatch refuses a caller session label without runtime identity', async () => {
  const slug = store.ensureProject(PROJ).slug;
  const ticket = await callTool('add', { title: 'missing runtime dispatch session', description: DISPATCH_DESCRIPTION, category: 'mcp-runtime-session' });
  const runtime = process.env.CLAUDE_CODE_SESSION_ID;
  const legacy = process.env.CLAUDE_SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CLAUDE_SESSION_ID;
  try {
    const refused = await callToolRaw('dispatch', { ref: ticket.ref, session: 'hh6-review' });
    assert.ok(refused.isError);
    assert.equal(refused.content[0].text, 'dispatch: MCP runtime session identity is unavailable. Reload Sidequest in Claude Code and retry; do not pass a session label.');
    assert.equal(store.getTicket(slug, ticket.ref).dispatch, null);
  } finally {
    process.env.CLAUDE_CODE_SESSION_ID = runtime;
    if (legacy == null) delete process.env.CLAUDE_SESSION_ID;
    else process.env.CLAUDE_SESSION_ID = legacy;
  }
});

test('dispatch returns a complete Claude worktree spawn spec', async () => {
  store.setCategory({ id: 'dispatch-fable', name: 'Dispatch Fable', route: { model: 'fable', effort: 'xhigh' } });
  const added = await callTool('add', { title: 'complete instant spawn', description: DISPATCH_DESCRIPTION, category: 'dispatch-fable', files: ['plugins/sidequest'] });
  const dispatched = await callTool('dispatch', { ref: added.ref, full: true });

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

test('MCP dispatch falls back to shared tree when the repo has no commits', async () => {
  const unborn = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-unborn-'));
  execFileSync('git', ['init', '--quiet'], { cwd: unborn, windowsHide: true });
  const added = await callTool('add', {
    project: unborn,
    title: 'unborn repo dispatch',
    description: DISPATCH_DESCRIPTION,
    category: 'coding.normal',
    files: ['src/work.ts'],
    verify: 'node --test test/work.test.ts',
  });

  const dispatched = await callTool('dispatch', { project: unborn, ref: added.ref, full: true });
  const stored = store.getTicket(added.project, added.ref);

  assert.strictEqual(dispatched.spawn.isolation, undefined);
  assert.strictEqual(stored.dispatch.sharedTree, true);
  assert.match(stored.dispatch.worktreeWarning, /repo has no commits/);
  assert.match(dispatched.warnings.join('\n'), /spawning in shared tree/);
});

test('MCP shared-tree dispatch activates the bounded artifact lifecycle', async () => {
  store.setCategory({ id: 'dispatch-artifact', name: 'Dispatch Artifact', route: { model: 'sonnet', effort: 'medium' }, artifactRoots: ['.claude/.codebase-info'] });
  const added = await callTool('add', {
    title: 'shared-tree artifact',
    description: `Write only the declared documentation artifact.\n${store.SHARED_TREE_ARTIFACT_MARKER}`,
    category: 'dispatch-artifact',
    files: ['.claude/.codebase-info/'],
  });
  const dispatched = await callTool('dispatch', { ref: added.ref, sharedTree: true, full: true });
  const stored = store.getTicket(added.project, added.ref);

  assert.strictEqual(dispatched.spawn.isolation, undefined);
  assert.strictEqual(stored.dispatch.sharedTree, true);
  assert.strictEqual(stored.dispatch.artifactMode, true);
  assert.match(agentsync.renderTicketBriefing(stored, dispatched.token), /\[sidequest-artifact-mode\]/);
});

test('native_agent carries ticket anchors and verify command through its stable fallback', async () => {
  seedCatalog([{ slug: 'codex-gpt-5-6-terra', id: 'claude-codex-gpt-5.6-terra', label: 'Terra' }]);
  try {
    store.setCategory({ id: 'native-codex', name: 'Native Codex', route: { model: 'codex-gpt-5-6-terra', effort: 'high' } });
    const added = await callTool('add', {
      title: 'prompt context', category: 'native-codex',
      anchors: 'lib/work.js:14 executorPrompt', verify: 'node --test plugins/sidequest/test/work.test.js',
    });
    const native = await callHandler('native_agent', { ref: added.ref, prompt: 'Implement exactly this ticket.' });
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

test('native_agent returns a complete Claude worktree spawn spec', async () => {
  store.setCategory({ id: 'native-fable', name: 'Native Fable', route: { model: 'fable', effort: 'xhigh' } });
  const added = await callTool('add', { title: 'complete native spawn', category: 'native-fable', files: ['plugins/sidequest'] });
  const native = await callHandler('native_agent', { ref: added.ref, prompt: 'Implement the ticket.' });

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

test('native_agent isolates declared-file tickets unless shared-tree is requested', async () => {
  seedCatalog([{ slug: 'codex-gpt-5-6-terra', id: 'claude-codex-gpt-5.6-terra', label: 'Terra' }]);
  try {
    store.setCategory({ id: 'native-worktree', name: 'Native Worktree', route: { model: 'codex-gpt-5-6-terra', effort: 'high' } });
    const added = await callTool('add', { title: 'worktree dispatch', category: 'native-worktree', files: ['plugins/sidequest'] });
    const isolated = await callHandler('native_agent', { ref: added.ref, prompt: 'Implement the ticket.' });
    const shared = await callHandler('native_agent', { ref: added.ref, prompt: 'Implement the ticket.', sharedTree: true });
    assert.equal(isolated.spawn.isolation, 'worktree');
    assert.equal(shared.spawn.isolation, undefined);
  } finally {
    clearCatalog();
  }
});

test('an unknown method is a JSON-RPC method-not-found error', async () => {
  const resp = await mcp.handleRequest({ jsonrpc: '2.0', id: 3, method: 'does/not/exist' });
  assert.ok(resp.error, 'returns an error object');
  assert.strictEqual(resp.error.code, -32601);
});

test('add rejects incomplete routing inputs', async () => {
  assert.ok((await callToolRaw('add', { title: 'no score' })).isError, 'missing complexity/why errors');
  assert.ok((await callToolRaw('add', { title: 'bad', complexity: 3, why: 'too short' })).isError, 'a thin why errors');
  assert.ok((await callToolRaw('add', { title: 'direct', complexity: 3, why: 'x'.repeat(25), model: 'grade-3' })).isError, 'a direct model errors');
});
test('add returns a compact acknowledgement', async () => {
  const out = await callTool('add', { title: 'MCP add works', complexity: 3, why: 'a real motivation referencing the actual single-file change' });
  assert.deepStrictEqual(Object.keys(out).sort(), ['ok', 'project', 'ref', 'status']);
  assert.match(out.ref, /^SQ-\d+$/);
  assert.strictEqual(out.status, 'todo');
});

test('category stamps warn until category_list is served by the MCP session', async () => {
  const session = freshMcpServer();
  const slug = store.ensureProject(PROJ).slug;
  const existing = store.createTicket(slug, { title: 'update without category', category: 'coding.easy' });
  const unchangedCategory = await callToolOn(session, 'update', { ref: existing.ref, title: 'update without a category stamp' });
  assert.equal(unchangedCategory.warnings, undefined);

  const warned = await callToolOn(session, 'add', { title: 'category stamped before read', category: 'coding.easy' });
  assert.deepEqual(warned.warnings, ['Category stamped without reading the taxonomy this session — run category_list and confirm the description matches.']);

  await callToolOn(session, 'category_list', {});
  const acknowledged = await callToolOn(session, 'add', { title: 'category stamped after read', category: 'coding.easy' });
  assert.equal(acknowledged.warnings, undefined);

  await callTool('category_list', {});
});

test('dispatch rejects a thin routed brief but only warns about a missing coding verify command', async () => {
  const added = await callTool('add', { title: 'thin dispatch fixture', category: 'debugging' });
  assert.equal(added.ok, true);
  const refused = await callToolRaw('dispatch', { ref: added.ref });
  assert.ok(refused.isError);
  assert.match(refused.content[0].text, /executor's entire brief is this ticket/);

  await callTool('update', { ref: added.ref, description: DISPATCH_DESCRIPTION });
  const dispatched = await callTool('dispatch', { ref: added.ref, full: true });
  assert.match(dispatched.warnings[0], /no verify command/);

  const research = await callTool('add', { title: 'research dispatch fixture', description: DISPATCH_DESCRIPTION, category: 'research' });
  assert.deepEqual((await callTool('dispatch', { ref: research.ref, full: true })).warnings, []);
});

test('readonly false keeps experiment-shaped spikes on the writing executor', async () => {
  const added = await callTool('add', {
    title: 'mutable spike dispatch fixture',
    description: DISPATCH_DESCRIPTION,
    category: 'spike-investigation',
    readonly: false,
  });
  assert.equal(store.getTicket(added.project, added.ref).readonlyOverride, false);
  const dispatched = await callTool('dispatch', { ref: added.ref, full: true });
  assert.doesNotMatch(dispatched.agent, /readonly/);
  assert.match(dispatched.warnings.join('\n'), /readonly override active/);

  await callTool('update', { ref: added.ref, readonly: false });
  assert.equal(store.getTicket(added.project, added.ref).readonlyOverride, false);
});

test('update returns a compact acknowledgement', async () => {
  store.setCategory({ id: 'mcp-update-echo', name: 'MCP update echo', route: { model: 'opus', effort: 'high' } });
  const added = await callTool('add', { title: 'MCP update echo', category: 'coding.easy' });
  const updated = await callTool('update', { ref: added.ref, category: 'mcp-update-echo' });
  assert.deepStrictEqual(Object.keys(updated).sort(), ['ok', 'project', 'ref', 'status']);
  assert.equal(store.getTicket(added.project, added.ref).categoryId, 'mcp-update-echo');
});

test('add and update attach unknown ticket-ref warnings to compact acknowledgements', async () => {
  const known = await callTool('add', { title: 'known ticket', unclassified: true });
  const added = await callTool('add', { title: `use ${known.ref} and SQ-9999`, unclassified: true });
  assert.deepStrictEqual(added.warnings, ['Unknown ticket refs: SQ-9999.']);

  const updated = await callTool('update', { ref: added.ref, description: 'now use SQ-9998' });
  assert.deepStrictEqual(updated.warnings, ['Unknown ticket refs: SQ-9999, SQ-9998.']);
});

test('status validation fails loudly and directs deletion to remove', async () => {
  const added = await callTool('add', { title: 'strict status', complexity: 1, why: 'exercise loud validation for invalid MCP status values' });
  const invalid = await callToolRaw('update', { ref: added.ref, status: 'deleted' });
  assert.ok(invalid.isError);
  assert.match(invalid.content[0].text, /Valid statuses: todo, doing, done/);
  assert.match(invalid.content[0].text, /remove tool/i);
  assert.throws(() => store.updateTicket(store.ensureProject(PROJ).slug, added.ref, { status: 'deleted' }), /remove tool/i);
  assert.throws(() => store.createTicket(store.ensureProject(PROJ).slug, { title: 'bad status', status: 'deleted' }), /remove tool/i);
});

test('CLI and MCP remove protect live claims but allow force and stale claims', async () => {
  const cliLive = await callTool('add', { title: 'CLI live claim removal', unclassified: true });
  assert.equal(store.claimTicket(cliLive.project, cliLive.ref, 'cli-live-worker', { direct: true }).ok, true);
  assert.throws(
    () => runCli(['rm', cliLive.ref, '--project', cliLive.project]),
    (error: any) => /live-claimed by "cli-live-worker".*--force/.test(error.stderr)
  );
  assert.ok(store.getTicket(cliLive.project, cliLive.ref));
  runCli(['rm', cliLive.ref, '--force', '--project', cliLive.project]);
  assert.equal(store.getTicket(cliLive.project, cliLive.ref), null);

  const cliStale = await callTool('add', { title: 'CLI stale claim removal', unclassified: true });
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

  const mcpLive = await callTool('add', { title: 'MCP live claim removal', unclassified: true });
  assert.equal(store.claimTicket(mcpLive.project, mcpLive.ref, 'mcp-live-worker', { direct: true }).ok, true);
  const refused = await callTool('remove', { project: mcpLive.project, ref: mcpLive.ref });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'claimed');
  assert.equal(refused.claim.by, 'mcp-live-worker');
  assert.ok(store.getTicket(mcpLive.project, mcpLive.ref));
  assert.equal((await callTool('remove', { project: mcpLive.project, ref: mcpLive.ref, force: true })).ok, true);
  assert.equal(store.getTicket(mcpLive.project, mcpLive.ref), null);

  const mcpStale = await callTool('add', { title: 'MCP stale claim removal', unclassified: true });
  assert.equal(store.claimTicket(mcpStale.project, mcpStale.ref, 'mcp-stale-worker', { direct: true }).ok, true);
  const staleMcpTicket = store.getTicket(mcpStale.project, mcpStale.ref);
  staleMcpTicket.claim.at = new Date(Date.now() - store.claimTtlMs() - 1).toISOString();
  db.putRow(db.openDb(SIDEQUEST_HOME), 'tickets', {
    id: staleMcpTicket.id, project: mcpStale.project, ref: staleMcpTicket.ref, status: staleMcpTicket.status,
    archived: staleMcpTicket.archived ? 1 : 0, ord: staleMcpTicket.order, claim_by: staleMcpTicket.claim.by, data: staleMcpTicket,
  });
  assert.equal((await callTool('remove', { project: mcpStale.project, ref: mcpStale.ref })).ok, true);
  assert.equal(store.getTicket(mcpStale.project, mcpStale.ref), null);
});

test('MCP archive and unarchive match the CLI ticket archive lifecycle', async () => {
  const cliTicket = await callTool('add', { title: 'CLI ticket archive', unclassified: true });
  const cliArchived = runCli(['archive', cliTicket.ref, '--project', cliTicket.project, '--json']);
  assert.equal(cliArchived.ok, true);
  assert.equal(store.getTicket(cliTicket.project, cliTicket.ref).archived, true);

  const restored = await callTool('unarchive', { project: cliTicket.project, ref: cliTicket.ref });
  assert.equal(restored.ok, true);
  assert.equal(store.getTicket(cliTicket.project, cliTicket.ref).archived, false);

  const mcpTicket = await callTool('add', { title: 'MCP ticket archive', unclassified: true });
  const archived = await callTool('archive', { project: mcpTicket.project, ref: mcpTicket.ref });
  assert.equal(archived.ok, true);
  assert.equal(store.getTicket(mcpTicket.project, mcpTicket.ref).archived, true);

  const cliRestored = runCli(['unarchive', mcpTicket.ref, '--project', mcpTicket.project, '--json']);
  assert.equal(cliRestored.ok, true);
  assert.equal(store.getTicket(mcpTicket.project, mcpTicket.ref).archived, false);
});

test('MCP admin/config tools share CLI state transitions', async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-admin-'));
  const project = store.ensureProject(projectPath).slug;
  const categoryId = `mcp-admin-${process.pid}`;
  const fallback = store.getRoutingFallback();
  try {
    const cliCategory = runCli(['category', 'add', categoryId, '--profile', 'coding', '--name', 'MCP admin category', '--route-model', 'sonnet', '--route-effort', 'low', '--json']);
    assert.equal(cliCategory.ok, true);
    assert.equal((await callTool('category_detach', { project, id: categoryId })).localRow.kind, 'DETACH');
    const relinked = runCli(['category', 'relink', categoryId, '--project', project, '--json']);
    assert.equal(relinked.localRow, null);

    const mcpFallback = await callTool('global_fallback', { project, model: 'sonnet', effort: 'low' });
    assert.deepEqual(runCli(['global-fallback', '--project', project, '--json']).fallback, mcpFallback.fallback);
    const cliFallback = runCli(['global-fallback', '--project', project, '--model', 'opus', '--effort', 'high', '--json']);
    assert.deepEqual((await callTool('global_fallback', { project })).fallback, cliFallback.fallback);

    const a = await callTool('add', { project, title: 'CLI assignment and link', unclassified: true });
    const b = await callTool('add', { project, title: 'MCP assignment and unlink', unclassified: true });
    assert.equal(runCli(['assign', a.ref, '--project', project, '--to', 'cli-owner', '--json']).ticket.assignee, 'cli-owner');
    assert.equal((await callTool('assign', { project, ref: a.ref, to: 'mcp-owner' })).assignee, 'mcp-owner');
    assert.equal(runCli(['link', a.ref, 'related', b.ref, '--project', project, '--json']).ok, true);
    assert.equal((await callTool('unlink', { project, a: a.ref, b: b.ref })).ok, true);
    assert.equal(store.getTicket(project, a.ref).links.length, 0);

    assert.deepEqual(await callTool('models', { project }), runCli(['models', '--project', project, '--json']));
    assert.deepEqual(await callTool('projects', {}), runCli(['projects', '--json']));
    assert.equal((await callTool('category_rm', { profile: 'coding', id: categoryId })).ok, true);

    const mcpCategoryId = `${categoryId}-mcp`;
    assert.equal((await callTool('category_add', {
      profile: 'coding', id: mcpCategoryId, name: 'MCP-created admin category', routeModel: 'sonnet', routeEffort: 'low',
    })).ok, true);
    assert.ok(runCli(['category', 'list', '--json']).categories.some((category: any) => category.id === mcpCategoryId));
    assert.equal(runCli(['category', 'rm', mcpCategoryId, '--profile', 'coding', '--json']).ok, true);
  } finally {
    if (fallback) store.setRoutingFallback(fallback);
  }
});


test('claim -> comment -> done return compact acknowledgements', async () => {
  const added = await callTool('add', { title: 'work me', complexity: 2, why: 'a straightforward change to exercise the claim/done path over MCP', labels: ['direct-ok'] });
  const ref = added.ref;
  const ticket = store.getTicket(added.project, ref);

  const claim = await callTool('claim', { ref, by: 'mcp-worker-1', direct: true, reason: 'The compact acknowledgement fixture needs a direct claim.' });
  assert.deepStrictEqual(Object.keys(claim).sort(), ['ok', 'project', 'ref', 'status']);
  assert.strictEqual(claim.status, 'doing');

  const note = await callTool('comment', { ref, body: 'progress note from an MCP tool call' });
  assert.deepStrictEqual(Object.keys(note).sort(), ['at', 'commentId', 'ok', 'project', 'ref', 'status']);
  const stored = store.getTicket(added.project, ref).comments.at(-1);
  assert.strictEqual(stored.source, 'mcp', 'MCP actions are tagged as background (not dashboard)');

  const done = await callTool('done', { ref, by: 'mcp-worker-1', model: ticket.model, effort: ticket.effort });
  assert.deepStrictEqual(Object.keys(done).sort(), ['ok', 'project', 'ref', 'status']);
  assert.strictEqual(done.status, 'done');
});

test('oversized comment acks advise without changing stored bodies', async () => {
  const project = store.ensureProject(path.join(os.tmpdir(), 'sq-mcp-comment-advisory')).slug;
  const ticket = store.createTicket(project, {
    title: 'comment advisory fixture', complexity: 1, complexityWhy: 'exercise the oversized comment acknowledgement without changing storage',
  });
  const small = 'Tight closeout with commit abc1234.';
  const large = `Verification output:\n${'測'.repeat(1400)}`;

  const smallAck = await callTool('comment', { project, ref: ticket.ref, body: small, by: 'advisory-worker' });
  const largeAck = await callTool('comment', { project, ref: ticket.ref, body: large, by: 'advisory-worker' });
  const stored = store.getTicket(project, ticket.ref).comments;

  assert.equal(smallAck.advisory, undefined);
  assert.match(largeAck.advisory, /body stored in full \(4\.1 KB\); default reads excerpt bodies past 1200 chars/);
  assert.strictEqual(stored[0].body, small);
  assert.strictEqual(stored[1].body, large);

  const completion = store.createTicket(project, {
    title: 'completion advisory fixture', complexity: 1, complexityWhy: 'exercise the oversized completion acknowledgement without changing storage',
  });
  await callTool('claim', { project, ref: completion.ref, by: 'advisory-worker', direct: true, reason: 'The completion advisory fixture requires a direct claim.' });
  const doneAck = await callTool('done', { project, ref: completion.ref, by: 'advisory-worker', model: completion.model, effort: completion.effort, body: large });
  assert.match(doneAck.advisory, /body stored in full \(4\.1 KB\); default reads excerpt bodies past 1200 chars/);
  assert.strictEqual(store.getTicket(project, completion.ref).comments.at(-1).body, large);
});

test('SQ-174: a spaced comment round-trips with spaces intact and no NUL bytes', async () => {
  const added = await callTool('add', { title: 'spaces intact', complexity: 1, why: 'exercise the MCP comment write path preserves internal spaces verbatim' });
  const ref = added.ref;
  const body = 'alpha  beta   gamma    delta'; // 2, 3, then 4 internal spaces
  const posted = await callTool('comment', { ref, body });
  assert.strictEqual(posted.ok, true);
  const back = await callTool('comments', { ref });
  assert.ok(back.comments[back.comments.length - 1].id, 'comments retain ids for replies and references');
  assert.equal(back.comments[back.comments.length - 1].source, undefined, 'comments omit storage-only source metadata');
  const stored = back.comments[back.comments.length - 1].body;
  assert.strictEqual(stored, body, 'the stored body equals the posted body verbatim');
  assert.ok(!stored.includes('\u0000'), 'no NUL byte anywhere in the stored body');
  assert.strictEqual((stored.match(/ /g) || []).length, 9, 'all nine internal spaces survive');
});

test('SQ-174: an author-supplied NUL (a NUL-separated key in prose) is stripped, not persisted', async () => {
  const added = await callTool('add', { title: 'nul stripped', complexity: 1, why: 'a comment describing a NUL-separated dedup key must not persist the raw 0x00' });
  const ref = added.ref;
  // Mirrors the real SQ-171 note that misfired: `source + '\0' + slug`, but with
  // a genuine 0x00 char between the quotes (as the reporter's body had).
  const body = 'dedup key: source + \u0000 + slug (works)';
  const posted = await callTool('comment', { ref, body });
  assert.strictEqual(posted.ok, true, 'the comment still stores (a lone control byte is normalized, not rejected)');
  const back = await callTool('comments', { ref });
  const stored = back.comments[back.comments.length - 1].body;
  assert.ok(!stored.includes('\u0000'), 'the raw NUL is gone from storage');
  assert.strictEqual(stored, 'dedup key: source +  + slug (works)', 'only the NUL is removed; surrounding spaces stay');
});

test('SQ-404: long handoff comments are stored whole and still have a clear cap', async () => {
  const added = await callTool('add', { title: 'long handoff', complexity: 1, why: 'confirm durable evidence can outlast the bounded executor digest' });
  const ref = added.ref;

  const handoff = 'x'.repeat(5481);
  const stored = await callTool('comment', { ref, body: handoff });
  assert.strictEqual(stored.ok, true, 'a useful long handoff stores whole');
  assert.strictEqual((await callTool('comments', { ref, full: true })).comments[0].body.length, 5481);

  const tooLong = 'x'.repeat(16001);
  const rejected = await callTool('comment', { ref, body: tooLong });
  assert.strictEqual(rejected.ok, false, 'the storage cap still rejects oversized bodies');
  assert.strictEqual(rejected.reason, 'too_long');
  assert.strictEqual(rejected.max, 16000, 'the error names the expanded cap');
  assert.strictEqual(rejected.length, 16001, 'the error names the actual length');
});

test('claim requires a worker id (no shared-identity default)', async () => {
  const added = await callTool('add', { title: 'needs by', complexity: 2, why: 'confirm the atomic-claim identity guard is enforced over MCP' });
  const res = await callToolRaw('claim', { ref: added.ref });
  assert.ok(res.isError, 'a claim without by is refused');
  assert.match(res.content[0].text, /by.*required/i);
});

test('MCP claim passes prepared dispatch token and executor through to the store', async () => {
  seedCatalog([{ id: 'claude-codex-gpt-5.6-terra[1m]', slug: 'codex-gpt-5-6-terra', label: 'GPT-5.6 Terra' }]);
  store.setCategory({ id: 'mcp-dispatch-claim', name: 'MCP dispatch claim', route: { model: 'codex-gpt-5-6-terra', effort: 'high' } });
  const added = await callTool('add', { title: 'nonce through MCP', category: 'mcp-dispatch-claim' });
  const slug = store.ensureProject(PROJ).slug;
  const prepared = store.prepareDispatch(slug, added.ref);
  const refused = await callTool('claim', { ref: added.ref, by: 'mcp-no-token' });
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.reason, 'token');
  const accepted = await callTool('claim', { ref: added.ref, by: 'mcp-with-token', token: prepared.token, executor: prepared.ticket.dispatchExecutor });
  assert.strictEqual(accepted.ok, true);
});

test('MCP blocks no-dispatch routed claims and records an explicit direct research bypass', async () => {
  const added = await callTool('add', { title: 'no-file research', category: 'coding.easy', labels: ['direct-ok'] });
  const ticket = store.getTicket(added.project, added.ref);
  assert.deepStrictEqual(ticket.files, []);
  const refused = await callTool('claim', { ref: added.ref, by: 'mcp-routed', effort: ticket.effort, executor: ticket.exec.agent });
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.reason, 'dispatch_required');
  assert.match(refused.message, /dispatch/i);
  assert.match(refused.message, /direct:true/i);
  const direct = await callTool('claim', { ref: added.ref, by: 'mcp-inline', direct: true, reason: 'The MCP research fixture requires a local direct claim.' });
  assert.strictEqual(direct.ok, true);
  const pulse = await callTool('pulse', { ref: added.ref, full: true });
  assert.strictEqual(pulse.direct.by, 'mcp-inline');
  assert.strictEqual(pulse.direct.model, ticket.model);
});

test('MCP claim rejects a generic executor for a Codex route', async () => {
  seedCatalog([{ id: 'claude-codex-gpt-5.6-terra[1m]', slug: 'codex-gpt-5-6-terra', label: 'GPT-5.6 Terra' }]);
  try {
    store.setCategory({ id: 'claim-codex', name: 'Claim Codex', route: { model: 'codex-gpt-5-6-terra', effort: 'high' } });
    const added = await callTool('add', { title: 'Codex executor guard', category: 'claim-codex' });
    const ticket = store.getTicket(store.ensureProject(PROJ).slug, added.ref);
    const rejected = await callTool('claim', { ref: added.ref, by: 'mcp-generic', effort: ticket.effort, executor: `sidequest-exec-${ticket.effort}` });
    assert.strictEqual(rejected.ok, false);
    assert.strictEqual(rejected.reason, 'executor_mismatch');
    assert.strictEqual(rejected.expectedExecutor, ticket.exec.agent);
  } finally {
    clearCatalog();
  }
});

test('claim with a mismatched effort is refused (drift guard mirrors the CLI)', async () => {
  const added = await callTool('add', { title: 'effort guard', category: 'coding.easy' });
  const ref = added.ref;
  const derived = store.getTicket(added.project, added.ref).effort;
  assert.ok(derived, 'routing on -> a derived effort');
  const wrong = store.VALID_EFFORTS.find((e: any) => e !== derived);
  const res = await callTool('claim', { ref, by: 'mcp-w', effort: wrong });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'effort_mismatch');
  assert.strictEqual(res.derivedEffort, derived);
  // The ticket must stay unclaimed after a refused claim.
  const after = await callTool('list', {});
  const t = after.tickets.find((x: any) => x.ref === ref);
  assert.strictEqual(t.status, 'todo');
  assert.strictEqual(t.claim, null);
});

test('MCP board reads omit category taxonomy while preserving claim TTL and category rows', async () => {
  const added = await callTool('add', { title: 'trimmed taxonomy response', category: 'coding.easy' });
  const list = await callTool('list', {});
  const ready = await callTool('ready', { brief: true });
  const changes = await callTool('changes', {});
  const pulse = await callTool('pulse', { ref: added.ref });

  assert.equal(list.categories, undefined);
  assert.equal(ready.categories, undefined);
  assert.equal(changes.categories, undefined);
  assert.equal(pulse.categories, undefined);
  assert.equal(typeof list.claimTtlMs, 'number');
  assert.equal(typeof ready.claimTtlMs, 'number');
  assert.equal(list.tickets.find((ticket: any) => ticket.ref === added.ref).categoryId, 'coding.easy');
  assert.equal(typeof ready.tickets.find((ticket: any) => ticket.ref === added.ref).categoryName, 'string');
});

test('MCP brief ready response stays under 2 KB', async () => {
  const small = store.ensureProject(path.join(os.tmpdir(), 'sq-mcp-trimmed-ready'), 'SQ trimmed ready');
  store.createTicket(small.slug, { title: 'the only ticket', category: 'coding.easy' });
  const out = await callToolRaw('ready', { project: small.slug, brief: true });
  assert.ok(out.content[0].text.length < 2048, `brief ready response is ${out.content[0].text.length} bytes`);
});


test('read-only calls can finish out of order while retaining their JSON-RPC ids', async () => {
  const tool = mcp.TOOLS.find((candidate: any) => candidate.name === 'list');
  const original = tool.handler;
  const releases: Array<() => void> = [];
  tool.handler = (args: any) => new Promise((resolve) => releases.push(() => resolve({ marker: args.marker })));
  try {
    const first = mcp.handleRequest({ jsonrpc: '2.0', id: 9101, method: 'tools/call', params: { name: 'list', arguments: { marker: 'first' } } });
    const second = mcp.handleRequest({ jsonrpc: '2.0', id: 9102, method: 'tools/call', params: { name: 'list', arguments: { marker: 'second' } } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(releases.length, 2);
    releases[1]!();
    const secondResponse = await second;
    releases[0]!();
    const firstResponse = await first;
    assert.equal(secondResponse.id, 9102);
    assert.equal(firstResponse.id, 9101);
    assert.deepEqual(JSON.parse(secondResponse.result.content[0].text), { marker: 'second' });
  } finally {
    tool.handler = original;
  }
});

test('mutations queue FIFO per board without blocking another board', async () => {
  const tool = mcp.TOOLS.find((candidate: any) => candidate.name === 'comment');
  const original = tool.handler;
  const started: string[] = [];
  const releases = new Map<string, () => void>();
  tool.handler = (args: any) => new Promise((resolve) => {
    started.push(args.marker);
    releases.set(args.marker, () => resolve({ marker: args.marker }));
  });
  const first = mcp.handleRequest({ jsonrpc: '2.0', id: 9201, method: 'tools/call', params: { name: 'comment', arguments: { project: PROJ, marker: 'first' } } });
  const second = mcp.handleRequest({ jsonrpc: '2.0', id: 9202, method: 'tools/call', params: { name: 'comment', arguments: { project: PROJ, marker: 'second' } } });
  const otherProject = store.ensureProject(path.join(os.tmpdir(), 'sq-mcp-fixtures', 'other-board')).slug;
  const other = mcp.handleRequest({ jsonrpc: '2.0', id: 9203, method: 'tools/call', params: { name: 'comment', arguments: { project: otherProject, marker: 'other' } } });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started, ['first', 'other']);
    releases.get('other')!();
    await other;
    releases.get('first')!();
    await first;
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started, ['first', 'other', 'second']);
    releases.get('second')!();
    await second;
  } finally {
    for (const release of releases.values()) release();
    await new Promise((resolve) => setImmediate(resolve));
    for (const release of releases.values()) release();
    await Promise.allSettled([first, second, other]);
    tool.handler = original;
  }
});

test('the real stdio server frames newline-delimited JSON-RPC', async () => {
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
  const lines = (res.stdout || '').split('\n').filter((l: any) => l.trim());
  const parsed = lines.map((l: any) => JSON.parse(l));
  // Three responses (the notification produced none).
  assert.strictEqual(parsed.length, 3, `expected 3 responses, got ${parsed.length}: ${res.stdout}`);
  assert.strictEqual(parsed[0].id, 1);
  assert.ok(parsed[0].result.serverInfo);
  assert.strictEqual(parsed[1].id, 2);
  assert.ok(Array.isArray(parsed[1].result.tools));
  assert.strictEqual(parsed[2].id, 3);
  assert.ok(!parsed[2].result.isError, 'list tool call succeeded');
});

test('models reports concrete routes and no grade output', async () => {
  seedCatalog([{ slug: 'codex-terra', id: 'claude-codex-gpt-5.6-terra[1m]', label: 'Codex Terra' }]);
  try {
    store.setCategory({ id: 'model-codex', name: 'Model Codex', route: { model: 'codex-terra', effort: 'high' }, fallback: { model: 'opus', effort: 'high' } });
    const out = await callHandler('models', {});
    assert.ok(out.models.includes('codex-terra'));
    assert.ok(out.categories.some((category: any) => category.id === 'model-codex' && category.resolved.model === 'codex-terra'));
    assert.ok(!JSON.stringify(out).includes('grade-'));
  } finally {
    clearCatalog();
  }
});

test('route_recipe resolves a live route and makes category errors explicit', async () => {
  seedCatalog([{ slug: 'codex-terra', id: 'claude-codex-gpt-5.6-terra[1m]', label: 'Codex Terra' }]);
  try {
    store.setCategory({ id: 'recipe-codex', name: 'Recipe Codex', route: { model: 'codex-terra', effort: 'high' } });
    const recipe = await callTool('route_recipe', { category: 'recipe-codex' });
    assert.deepEqual(recipe.route, { model: 'codex-terra', effort: 'high' });
    assert.deepEqual(recipe.agent, {
      model: agentsync.DISPATCH_MODEL_ID,
      promptPrefix: '[sidequest-route model=gpt-5.6-terra effort=high]\n\n',
    });
    assert.equal(recipe.effortCarrier, 'marker');
    assert.deepEqual(recipe.warnings, []);

    store.setCategory({ id: 'recipe-disabled', name: 'Recipe Disabled', route: { model: 'sonnet', effort: 'high' }, enabled: false });
    const disabled = await callToolRaw('route_recipe', { category: 'recipe-disabled' });
    assert.ok(disabled.isError);
    assert.match(disabled.content[0].text, /disabled for this project/i);

    const unknown = await callToolRaw('route_recipe', { category: 'missing-recipe' });
    assert.ok(unknown.isError);
    assert.match(unknown.content[0].text, /unknown/i);

    const resolveCategoryRoute = store.resolveCategoryRoute;
    store.resolveCategoryRoute = () => ({ exec: null });
    try {
      const unroutable = await callToolRaw('route_recipe', { category: 'recipe-codex' });
      assert.ok(unroutable.isError);
      assert.match(unroutable.content[0].text, /no available route/i);
    } finally {
      store.resolveCategoryRoute = resolveCategoryRoute;
    }
  } finally {
    clearCatalog();
  }
});

test('done stamps workedBy with a discovered Codex slug', async () => {
  seedCatalog([{ slug: 'codex-terra', id: 'claude-codex-gpt-5.6-terra[1m]' }]);
  try {
    store.setCategory({ id: 'provenance-codex', name: 'Provenance Codex', route: { model: 'codex-terra', effort: 'high' } });
    const added = await callTool('add', { title: 'codex provenance', category: 'provenance-codex' });
    const ref = added.ref;
    await callTool('claim', { ref, by: 'mcp-w-codex' });
    const done = await callTool('done', { ref, by: 'mcp-w-codex', model: 'codex-terra', effort: 'high' });
    assert.strictEqual(done.ok, true);
    assert.strictEqual(store.getTicket(added.project, ref).workedBy.model, 'codex-terra');
  } finally {
    clearCatalog();
  }
});

test('reporting aliases resolve to catalog slugs and dispatched done defaults provenance', async () => {
  seedCatalog([
    { slug: 'codex-gpt-5-6-terra-fast', id: 'claude-codex-gpt-5.6-terra-fast[1m]' },
    { slug: 'codex-gpt-5-6-luna-fast', id: 'claude-codex-gpt-5.6-luna-fast[1m]' },
  ]);
  try {
    store.setCategory({ id: 'alias-codex', name: 'Alias Codex', route: { model: 'codex-gpt-5-6-terra-fast', effort: 'high' } });
    const complete = async (title: any, model?: any) => {
      const added = await callTool('add', {
        title,
        category: 'alias-codex',
        description: DISPATCH_DESCRIPTION,
        verify: 'node --test test/mcp.test.js',
      });
      const prepared = await callTool('dispatch', { ref: added.ref, full: true });
      const by = `mcp-alias-${added.ref}`;
      await callTool('claim', { ref: added.ref, by, executor: prepared.agent, effort: 'high', token: prepared.token });
      await callTool('done', { ref: added.ref, by, ...(model == null ? {} : { model, effort: 'high' }) });
      return store.getTicket(added.project, added.ref);
    };

    for (const alias of ['gpt-5.6-terra-fast', 'claude-codex-gpt-5.6-terra-fast[1m]', 'CLAUDE-CODEX-GPT-5.6-TERRA-FAST']) {
      const ticket = await complete(`alias ${alias}`, alias);
      assert.equal(ticket.workedBy.model, 'codex-gpt-5-6-terra-fast');
    }
    assert.equal(store.classifyModelFilter('gpt-5.6-terra-fast'), 'codex-gpt-5-6-terra-fast');
    assert.equal(store.classifyModelFilter('claude-codex-gpt-5.6-terra-fast'), 'codex-gpt-5-6-terra-fast');
    assert.throws(() => store.setCategory({
      id: 'alias-route-rejected',
      name: 'Alias Route Rejected',
      route: { model: 'gpt-5.6-terra-fast', effort: 'high' },
    }), /valid model and effort/);
    await callTool('ready', { model: 'gpt-5.6-terra-fast' });

    const defaulted = await complete('dispatched default');
    assert.deepEqual(defaulted.workedBy.model, 'codex-gpt-5-6-terra-fast');
    assert.deepEqual(defaulted.workedBy.effort, 'high');

    const overridden = await complete('dispatched alternate model', 'gpt-5.6-luna-fast');
    assert.equal(overridden.workedBy.model, 'codex-gpt-5-6-luna-fast');

    const added = await callTool('add', {
      title: 'unknown alias',
      category: 'alias-codex',
      description: DISPATCH_DESCRIPTION,
      verify: 'node --test test/mcp.test.js',
    });
    const prepared = await callTool('dispatch', { ref: added.ref, full: true });
    const unknown = await callToolRaw('done', { ref: added.ref, by: 'mcp-alias-unknown', model: 'claude-codex-auto' });
    assert.ok(unknown.isError);
    assert.match(unknown.content[0].text, /expected for .*: codex-gpt-5-6-terra-fast/);
    assert.equal(store.getTicket(added.project, added.ref).dispatchNonce, prepared.token);
  } finally {
    clearCatalog();
  }
});

test('ready with an unrecognized model errors instead of silently meaning "no filter"', async () => {
  const res = await callToolRaw('ready', { model: 'totally-bogus-tier' });
  assert.ok(res.isError, 'an unrecognized model filter is refused, not silently ignored');
  assert.match(res.content[0].text, /unknown model/i);
  assert.match(res.content[0].text, /totally-bogus-tier/, 'names the offending value');
});

test('claim guard refusal names the Codex-backed executor for a concrete route', async () => {
  seedCatalog([{ slug: 'codex-terra', id: 'claude-codex-gpt-5.6-terra[1m]' }]);
  try {
    store.setCategory({ id: 'guard-codex', name: 'Guard Codex', route: { model: 'codex-terra', effort: 'high' } });
    const added = await callTool('add', { title: 'codex guard', category: 'guard-codex' });
    const wrong = store.VALID_EFFORTS.find((effort: any) => effort !== store.getTicket(added.project, added.ref).effort);
    const res = await callTool('claim', { ref: added.ref, by: 'mcp-w-guard', effort: wrong });
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
async function resultChars(name?: any, args?: any) {
  const resp = await mcp.handleRequest({ jsonrpc: '2.0', id: ++idc, method: 'tools/call', params: { name, arguments: args || {} } });
  return resp.result.content[0].text.length;
}

test('SQ-228: a large board pages under the cap; cursors iterate the full set exactly once', async () => {
  // A dedicated board so seeding 500 tickets can't perturb the shared-board
  // tests above. Every call passes project explicitly.
  const big = store.ensureProject(path.join(os.tmpdir(), 'sq-mcp-bigboard-228'), 'SQ-228 Big Board');
  const N = 500;
  for (let i = 0; i < N; i++) {
    store.createTicket(big.slug, { title: `bulk todo ticket number ${i} on the oversized board`, files: [`lib/mod-${i}.js`] });
  }

  // all:true is the escape hatch — the whole column in one call, and (this is the
  // bug) it serializes far past the tool-result ceiling. total/returned agree.
  const allRes = await callTool('list', { project: big.slug, all: true });
  assert.strictEqual(allRes.total, N, 'all:true reports the true total');
  assert.strictEqual(allRes.returned, N, 'all:true returns every ticket');
  assert.strictEqual(allRes.tickets.length, N, 'all 500 present under all:true');
  assert.strictEqual(allRes.nextCursor, null, 'all:true has no next page');
  const allChars = await resultChars('list', { project: big.slug, all: true });
  assert.ok(allChars > 100000, `unbounded all:true overflows (${allChars} chars) — reproduces the bug`);

  // Page 1 (default): bounded well under the ceiling, reports the true total, and
  // hands back a cursor because there's more.
  const p1 = await callTool('list', { project: big.slug });
  assert.strictEqual(p1.total, N, 'page 1 reports the true total');
  assert.ok(p1.returned > 0 && p1.returned < N, 'page 1 is a partial page');
  assert.strictEqual(p1.tickets.length, p1.returned, 'returned matches the array length');
  assert.ok(p1.nextCursor, 'page 1 hands back a cursor');
  assert.match(p1.hint, /cursor/, 'the hint tells the caller to follow the cursor');
  const p1Chars = await resultChars('list', { project: big.slug });
  assert.ok(p1Chars < 90000, `page 1 stays under the ceiling (${p1Chars} chars vs unbounded ${allChars})`);

  // Iterate the cursor to exhaustion: collect every ref, assert we saw all 500
  // exactly once, every page fit under the ceiling, and paging terminates.
  const seen = [];
  let cursor = undefined;
  let pages = 0;
  let maxPageChars = 0;
  do {
    const args = cursor === undefined ? { project: big.slug } : { project: big.slug, cursor };
    maxPageChars = Math.max(maxPageChars, await resultChars('list', args));
    const page = await callTool('list', args);
    for (const t of page.tickets) seen.push((t as any).ref);
    cursor = page.nextCursor;
    pages++;
    assert.ok(pages <= N + 5, 'paging terminates (no runaway loop)');
  } while (cursor);

  assert.ok(maxPageChars < 90000, `every page stayed under the ceiling (max ${maxPageChars} chars)`);
  assert.strictEqual(seen.length, N, 'iterating cursors yielded exactly N rows');
  assert.strictEqual(new Set(seen).size, N, 'every ticket appears exactly once (no dupes, no gaps)');
  assert.ok(pages >= 2, `a 500-ticket board takes several pages (took ${pages})`);

  // limit:N is an exact page size and its own cursor advances correctly.
  const capped = await callTool('list', { project: big.slug, limit: 10 });
  assert.strictEqual(capped.returned, 10, 'limit:N returns exactly N');
  assert.strictEqual(capped.tickets.length, 10, 'exactly N rows');
  assert.strictEqual(capped.total, N, 'the true total rides alongside the page');
  assert.strictEqual(capped.nextCursor, '10', 'the cursor is the next offset');
  const capped2 = await callTool('list', { project: big.slug, limit: 10, cursor: capped.nextCursor });
  assert.strictEqual(capped2.returned, 10, 'page 2 is also exactly N');
  assert.strictEqual(capped2.nextCursor, '20', 'page 2 advances the cursor to offset 20');
  assert.notStrictEqual(capped2.tickets[0].ref, capped.tickets[0].ref, 'page 2 starts past page 1');
  // The two limit-pages are disjoint and contiguous (no overlap, no gap).
  const p1Refs = new Set(capped.tickets.map((t: any) => t.ref));
  assert.ok(!capped2.tickets.some((t: any) => p1Refs.has(t.ref)), 'limit pages do not overlap');

  // A small board is a single call: no cursor, everything returned (backward
  // compatible). Brief row shape is untouched (SQ-220 parity).
  const small = store.ensureProject(path.join(os.tmpdir(), 'sq-mcp-smallboard-228'), 'SQ-228 Small Board');
  store.createTicket(small.slug, { title: 'the only ticket' });
  const smallList = await callTool('list', { project: small.slug });
  assert.strictEqual(smallList.nextCursor, null, 'a small board fits in one page');
  assert.strictEqual(smallList.returned, smallList.tickets.length);
  assert.strictEqual(smallList.total, smallList.tickets.length);
  assert.strictEqual(smallList.hint, undefined, 'no paging hint when there is no next page');
});

export {};
