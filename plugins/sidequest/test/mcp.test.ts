import './_temp-cleanup.js';
import './_sidequest-install-fixture.js';
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
// Per-process fixture root. A fixed path under the OS temp directory is shared
// with every other suite run on this machine and with the real `sidequest temp
// cleanup` sweep, either of which deletes this repo mid-run and takes the two
// dispatch tests that need a live work tree with it (SQ-867).
const FIXTURE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-fixtures-'));
const PROJ = path.join(FIXTURE_ROOT, 'board');
fs.mkdirSync(PROJ, { recursive: true });
execFileSync('git', ['init', '--quiet'], { cwd: PROJ, windowsHide: true });
execFileSync('git', ['-c', 'user.name=Sidequest Tests', '-c', 'user.email=sidequest@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'fixture'], { cwd: PROJ, windowsHide: true });
process.env.CLAUDE_PROJECT_DIR = PROJ;
const MCP_SESSION_ID = `mcp-test-session-${process.pid}`;
process.env.CLAUDE_CODE_SESSION_ID = MCP_SESSION_ID;
// Start with no discovery root at all — a real machine (e.g. this one, with
// model-gateway installed) can have a genuine ~/.claude/model-gateway/catalog.json,
// which would otherwise leak real discovered slugs into these tests. The
// SQ-162 tests below point SIDEQUEST_DISCOVERY_DIRS at their own fake catalog.
const NO_CATALOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-nocatalog-'));
process.env.SIDEQUEST_DISCOVERY_DIRS = NO_CATALOG_DIR;

const mcp = require('../lib/mcp.js');
const agentsync = require('../lib/agentsync.js');
const store = require('../lib/store.js');
const DISPATCH_DESCRIPTION = 'Where: the routed test fixture. Contract: prepare a stable executor without changing the ticket title. Verify: inspect the dispatch result.';
const NO_SCOPE_WARNING = 'Planning-depth warning: no file scope declared for a write-scope ticket. The executor will block at its first write, request scope, and may end before a ruling with no submission. Declare files now, or dispatch only with an explicit unscoped override.';

// Write a fake model-gateway catalog (mirrors test/discovery.test.js) so a
// discovered+enabled custom slug can be exercised over the MCP surface.
function writeCatalogRaw(dir?: any, body?: any) {
  fs.mkdirSync(path.join(dir, 'model-gateway'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'model-gateway', 'catalog.json'), body);
}
function seedCatalog(models?: any, codexReadiness: any = {
  ready: true,
  state: 'ready',
  message: 'Codex readiness confirms local binary, /v1/models, authentication, shim, and serving-version checks.',
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-catalog-'));
  writeCatalogRaw(dir, JSON.stringify({ schemaVersion: 3, source: 'model-gateway', updatedAt: new Date().toISOString(), codexReadiness, models }));
  process.env.SIDEQUEST_DISCOVERY_DIRS = dir;
  return dir;
}
function seedCatalogV4(models?: any, providers?: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-catalog-'));
  writeCatalogRaw(dir, JSON.stringify({ schemaVersion: 4, source: 'model-gateway', updatedAt: new Date().toISOString(), providers, models }));
  process.env.SIDEQUEST_DISCOVERY_DIRS = dir;
  return dir;
}
function clearCatalog() {
  process.env.SIDEQUEST_DISCOVERY_DIRS = NO_CATALOG_DIR;
}
seedCatalog([
  { id: 'claude-gpt-5.6-terra', slug: 'codex-gpt-5-6-terra', label: 'GPT-5.6 Terra' },
  { id: 'claude-gpt-5.6-luna', slug: 'codex-gpt-5-6-luna', label: 'GPT-5.6 Luna' },
]);
function committedRepo(prefix?: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  // Pin the branch: integrationTarget resolves "main", and release suites run with
  // GIT_CONFIG_NOSYSTEM=1, so the ambient init.defaultBranch is not there to supply it.
  execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: root, windowsHide: true });
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
  // The space is the point: every commit/submit path below runs against a
  // worktree whose absolute path contains one. Keep the sq- prefix too, it is
  // what the temp tracker and `temp cleanup` key on.
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp worktree-'));
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

function addMarketplaceFixture(worktree: string) {
  const marketplacePath = path.join(worktree, '.claude-plugin');
  fs.mkdirSync(marketplacePath, { recursive: true });
  fs.writeFileSync(path.join(marketplacePath, 'marketplace.json'), JSON.stringify({
    plugins: [{ name: 'fixture-plugin', source: './plugins/fixture-plugin' }],
  }));
  gitAt(worktree, ['add', '.claude-plugin/marketplace.json']);
  gitAt(worktree, ['commit', '-m', 'fixture marketplace']);
  gitAt(worktree, ['push']);
}

function windowsShortPath(pathname: string) {
  if (process.platform !== 'win32') return pathname;
  return execFileSync('cmd.exe', ['/d', '/c', `for %I in ("${pathname}") do @echo %~sI`], {
    encoding: 'utf8', windowsHide: true, shell: true,
  }).trim();
}

function createLinkedWorktree(primary?: any) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-linked-worktree-'));
  const linked = path.join(parent, 'linked');
  gitAt(primary, ['worktree', 'add', '--detach', linked, 'HEAD']);
  return linked;
}

function claimDispatchedTicket(project?: any, ticket?: any, by?: any, sharedTree?: any) {
  const prepared = store.prepareDispatch(project, ticket.ref, { sharedTree });
  assert.equal(store.claimTicket(project, ticket.ref, by, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);
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
  for (const expected of ['list', 'ready', 'add', 'update', 'remove', 'archive', 'unarchive', 'claim', 'sweepClaims', 'next', 'done', 'groomClose', 'release', 'verdict', 'scopeRequest', 'commit', 'submit', 'comment', 'plan', 'link', 'unlink', 'assign', 'dispatch', 'story', 'story_contract', 'story_log', 'category_add', 'category_edit', 'category_rm', 'category_detach', 'category_relink', 'category_list', 'global_fallback', 'board_config', 'models', 'projects', 'archive_board', 'unarchive_board', 'route_recipe']) {
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
  // body/commit are enforced by the handler for an ordinary submission, but are
  // not schema-required: clear:true (SQ-1010's reject-without-integrating path)
  // legitimately omits both.
  assert.ok(submit.inputSchema.properties.clear, 'submit exposes clear to reject a pending submission without integrating it');
  assert.equal(submit.inputSchema.required.includes('body'), false, 'body is handler-enforced, not schema-required, so clear:true can omit it');
  assert.ok(resp.result.tools.find((tool: any) => tool.name === 'done').inputSchema.required.includes('body'), 'done requires the final report');
  const release = resp.result.tools.find((tool: any) => tool.name === 'release');
  assert.ok(release.inputSchema.properties.oracle, 'release exposes an oracle ask');
  assert.deepEqual(release.inputSchema.properties.kind.enum, ['technical_blocker', 'contradiction', 'handback'], 'release classifies reasoned handoffs');
  assert.ok(release.inputSchema.properties.command, 'release exposes command evidence for technical blockers and contradictions');
  assert.match(release.inputSchema.properties.command.description, /Required for blocker\/contradiction/);
  assert.ok(release.inputSchema.properties.exitCode, 'release exposes optional contradiction and required technical-blocker exit-code evidence');
  assert.ok(release.inputSchema.properties.outputTail, 'release exposes output evidence for technical blockers and contradictions');
  assert.match(release.inputSchema.properties.outputTail.description, /Required blocker\/contradiction output/);
  assert.equal(release.inputSchema.required.includes('reason'), false, 'release accepts an oracle ask in place of a reason');
  const verdict = resp.result.tools.find((tool: any) => tool.name === 'verdict');
  assert.deepEqual(verdict.inputSchema.required, ['ref', 'text', 'outcome']);
  assert.deepEqual(verdict.inputSchema.properties.outcome.enum, ['accepted', 'rejected', 'inconclusive']);
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

// SQ-900: a 25- and then 28-entry files array both returned ok:true and persisted
// only the first 20, so the executor's board commit refused paths the orchestrator
// had already approved. A scope write now round-trips whole, or it is refused.
test('add and update persist a declared scope past 20 entries and refuse an over-limit one', async () => {
  const project = store.ensureProject(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-scope-cap-'))).slug;
  const scope = (count: number) => Array.from({ length: count }, (_, i) => `plugins/sidequest/src/lib/part-${String(i).padStart(3, '0')}.ts`);

  const added = await callTool('add', { project, title: 'wide declared scope', files: scope(25), unclassified: true });
  assert.deepEqual(store.getTicket(project, added.ref).files, scope(25));

  await callTool('update', { project, ref: added.ref, files: scope(28) });
  assert.deepEqual(store.getTicket(project, added.ref).files, scope(28));
  const listed = (await callTool('list', { project, detail: true })).tickets.find((ticket: any) => ticket.ref === added.ref);
  assert.deepEqual(listed.files, scope(28));

  const rejected = await callToolRaw('update', { project, ref: added.ref, files: scope(store.DECLARED_FILES_MAX + 3) });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, new RegExp(`at most ${store.DECLARED_FILES_MAX} entries.*${store.DECLARED_FILES_MAX + 3} \\(3 over\\)`));
  assert.match(rejected.content[0].text, /directory entries/);
  assert.deepEqual(store.getTicket(project, added.ref).files, scope(28), 'a refused write leaves the approved scope untouched');

  const rejectedAdd = await callToolRaw('add', { project, title: 'too wide', unclassified: true, files: scope(store.DECLARED_FILES_MAX + 1) });
  assert.equal(rejectedAdd.isError, true);
  assert.match(rejectedAdd.content[0].text, /declared file scope accepts at most/);

  const contracts = await callTool('add', {
    project, title: 'wide contracts', unclassified: true,
    produces: scope(24).map((file) => `Payload:${file}`), consumes: scope(23).map((file) => `Input:${file}`), changes: scope(22).map((file) => `Shape:${file}`),
  });
  const stored = store.getTicket(project, contracts.ref).contracts;
  assert.deepEqual([stored.produces.length, stored.consumes.length, stored.changes.length], [24, 23, 22]);

  const rejectedContract = await callToolRaw('add', { project, title: 'too many contracts', unclassified: true, produces: scope(store.CONTRACT_NAMES_MAX + 1).map((file) => `Payload:${file}`) });
  assert.equal(rejectedContract.isError, true);
  assert.match(rejectedContract.content[0].text, /contract produces accepts at most/);

  const labels = Array.from({ length: store.LABELS_MAX + 1 }, (_, i) => `label-${i}`);
  const rejectedLabels = await callToolRaw('add', { project, title: 'too many labels', unclassified: true, labels });
  assert.equal(rejectedLabels.isError, true);
  assert.match(rejectedLabels.content[0].text, /labels accepts at most/);
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

test('story MCP tool covers the CLI story lifecycle', async () => {
  const project = store.ensureProject(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-story-lifecycle-'))).slug;
  const created = await callTool('story', {
    project, action: 'add', title: 'MCP story', description: 'Group story work.', color: 'teal',
  });
  assert.equal(created.ok, true);
  assert.equal(created.project, project);
  assert.equal(created.story.title, 'MCP story');

  const ticket = store.createTicket(project, { title: 'Story member', storyId: created.story.ref, source: 'test' });
  const listed = await callTool('story', { project, action: 'list' });
  assert.equal(listed.stories[0].ticketCount, 1);
  const shown = await callTool('story', { project, action: 'show', story: created.story.id });
  assert.deepEqual(shown.tickets.map((entry: any) => entry.ref), [ticket.ref]);

  const updated = await callTool('story', { project, action: 'update', story: created.story.ref, title: 'Renamed story' });
  assert.equal(updated.ok, true);
  assert.equal(updated.story.title, 'Renamed story');
  const removed = await callTool('story', { project, action: 'rm', story: created.story.ref });
  assert.equal(removed.ok, true);
  assert.equal(removed.story.id, created.story.id);
  assert.equal(store.getTicket(project, ticket.ref).storyId, null);
});

test('story MCP tool rejects missing and invalid identifiers', async () => {
  const project = store.ensureProject(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-story-identifiers-'))).slug;
  for (const action of ['show', 'update', 'rm']) {
    const missing = await callToolRaw('story', { project, action });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, new RegExp(`story ${action}: pass a story ref`));
  }
  for (const action of ['show', 'update']) {
    const missing = await callToolRaw('story', { project, action, story: 'US-999' });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, new RegExp(`story ${action}: no story "US-999"`));
  }
  const removed = await callTool('story', { project, action: 'rm', story: 'US-999' });
  assert.deepEqual(removed, { ok: false, project, story: null });
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

test('story_log reads, appends from a claimed member, and rotates after promotion', async () => {
  const project = store.ensureProject(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-story-log-'))).slug;
  const story = store.createStory(project, { title: 'Decision log packet' });
  const ticket = store.createTicket(project, { title: 'Member ticket', storyId: story.ref, source: 'test' });
  assert.equal(store.claimTicket(project, ticket.ref, 'log-worker', { direct: true }).ok, true);

  const empty = await callTool('story_log', { project, story: story.ref });
  assert.equal(empty.story.logBytes, 0);
  assert.equal(empty.story.logCapacity, 16 * 1024);
  assert.equal(empty.story.logRevision, 0);
  assert.deepEqual(empty.story.entries, []);

  const appended = await callTool('story_log', {
    project, story: story.ref, ref: ticket.ref, by: 'log-worker', entry: 'DISCOVERY: CLI and MCP share the same store API.',
  });
  assert.equal(appended.story.logRevision, 1);
  assert.deepEqual(
    { ref: appended.story.entries[0].ref, by: appended.story.entries[0].by, kind: appended.story.entries[0].kind, text: appended.story.entries[0].text },
    { ref: ticket.ref, by: 'log-worker', kind: 'DISCOVERY', text: 'CLI and MCP share the same store API.' },
  );

  const rotated = await callTool('story_log', { project, story: story.ref, rotate: true, by: 'orchestrator' });
  assert.equal(rotated.story.logBytes, 0);
  assert.equal(rotated.story.logCapacity, 16 * 1024);
  assert.equal(rotated.story.logRevision, 1);
  assert.deepEqual(rotated.story.entries, []);
  assert.equal(rotated.story.archivedEntries, 1);
  const denied = await callToolRaw('story_log', { project, story: story.ref, rotate: true, by: 'log-worker' });
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /rotate:true requires by:"orchestrator"/);
});

test('MCP rejects unsupported write and read parameters before they can be ignored', async () => {
  const project = store.ensureProject(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-strict-arguments-'))).slug;
  const story = store.createStory(project, { title: 'Strict arguments' });
  const ticket = store.createTicket(project, { title: 'Member ticket', storyId: story.ref, source: 'test' });
  assert.equal(store.claimTicket(project, ticket.ref, 'argument-worker', { direct: true }).ok, true);

  const invalidStoryLogArguments = [
    { text: 'DISCOVERY: ignored entry' },
    { kind: 'DISCOVERY' },
  ];
  for (const invalidArguments of invalidStoryLogArguments) {
    const parameter = Object.keys(invalidArguments)[0];
    const rejected = await callToolRaw('story_log', Object.assign({
      project, story: story.ref, ref: ticket.ref, by: 'argument-worker',
    }, invalidArguments));
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, new RegExp(`story_log: unknown argument \"${parameter}\" — story_log accepts: .*entry`));
  }
  assert.deepEqual(store.storyDecisionLog(store.getStory(project, story.ref)).entries, []);

  const rejectedComments = await callToolRaw('comments', { project, ref: ticket.ref, order: 'newest' });
  assert.equal(rejectedComments.isError, true);
  assert.match(rejectedComments.content[0].text, /comments: unknown argument "order" — comments accepts: .*ref/);
});

test('MCP category_edit rejects guessed fields and reports applied routing changes', async () => {
  const project = store.ensureProject(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-category-edit-'))).slug;
  const rejectedEffort = await callToolRaw('category_edit', { project, id: 'coding.normal', effort: 'medium' });
  assert.equal(rejectedEffort.isError, true);
  assert.match(rejectedEffort.content[0].text, /category_edit: unknown argument "effort" — category_edit accepts: id, project, profile, name, description, contract, artifactRoots, routeModel, routeEffort, fallbackModel, fallbackEffort, enabled, readonly\./);

  const rejectedRoute = await callToolRaw('category_edit', { project, id: 'coding.normal', route: { model: 'codex-gpt-5-6-luna', effort: 'medium' } });
  assert.equal(rejectedRoute.isError, true);
  assert.match(rejectedRoute.content[0].text, /category_edit: unknown argument "route" — category_edit accepts:/);

  const edited = await callTool('category_edit', {
    project,
    id: 'coding.normal',
    routeModel: 'codex-gpt-5-6-luna',
    routeEffort: 'medium',
    fallbackModel: 'codex-gpt-5-6-terra',
    fallbackEffort: 'low',
    readonly: true,
  });
  assert.deepEqual(edited.changed.sort(), ['fallback', 'readonly', 'route']);
  assert.equal(edited.localRow.kind, 'DETACH');

  const unchanged = await callTool('category_edit', {
    project,
    id: 'coding.normal',
    routeModel: 'codex-gpt-5-6-luna',
    routeEffort: 'medium',
    fallbackModel: 'codex-gpt-5-6-terra',
    fallbackEffort: 'low',
    readonly: true,
  });
  assert.deepEqual(unchanged.changed, []);

  const clearedFallback = await callTool('category_edit', { project, id: 'coding.normal', fallbackModel: null });
  assert.deepEqual(clearedFallback.changed, ['fallback']);
  assert.equal(store.getCategory('coding.normal', { project }).fallback, null);
});

test('list returns verify while retaining executorVerify for compatibility', async () => {
  const project = store.ensureProject(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-verify-name-'))).slug;
  const ticket = store.createTicket(project, {
    title: 'Verify field', executorVerify: 'node --test plugins/sidequest/test/mcp.test.ts', source: 'test',
  });

  const listed = await callTool('list', { project, all: true, detail: true });
  const row = listed.tickets.find((candidate: any) => candidate.ref === ticket.ref);
  assert.equal(row.verify, ticket.executorVerify);
  assert.equal(row.executorVerify, ticket.executorVerify);
});

test('tools/list reports schema size for trend tracking without an arbitrary ceiling', async (context: { diagnostic(message: string): void }) => {
  const tools = mcp.toolDescriptors();
  const descriptionBytes = (value: any): number => {
    if (Array.isArray(value)) return value.reduce((total, entry) => total + descriptionBytes(entry), 0);
    if (!value || typeof value !== 'object') return 0;
    return Object.entries(value).reduce((total, [key, entry]) =>
      total + (key === 'description' && typeof entry === 'string' ? Buffer.byteLength(entry) : descriptionBytes(entry)), 0);
  };
  const total = descriptionBytes(tools);
  const payload = JSON.stringify({ tools });
  const baseline = { descriptionBytes: 2047, payloadBytes: 17492 };
  context.diagnostic(`tools/list size: ${tools.length} tools, ${total} description bytes (baseline ${baseline.descriptionBytes}), ${Buffer.byteLength(payload)} payload bytes (baseline ${baseline.payloadBytes})`);
  assert.match(tools.find((tool: any) => tool.name === 'claim').description, /ok:true/);
  assert.match(tools.find((tool: any) => tool.name === 'dispatch').description, /stable route/);
  assert.match(tools.find((tool: any) => tool.name === 'done').description, /actual model and effort/);
  assert.match(tools.find((tool: any) => tool.name === 'list').description, /^For liveness\/progress polling use changes\/pulse, not this\./);
  const list = tools.find((tool: any) => tool.name === 'list');
  assert.match(list.inputSchema.properties.detail.description, /^Audit only:/);
  assert.match(list.inputSchema.properties.detail.description, /liveness uses changes\/pulse/);
  assert.match(tools.find((tool: any) => tool.name === 'comments').description, /^Read comments before work; history is chronological/);
  const comments = tools.find((tool: any) => tool.name === 'comments');
  assert.match(comments.inputSchema.properties.full.description, /^Recovery read:/);
  assert.match(comments.inputSchema.properties.full.description, /1200 chars\/body/);
  assert.match(comments.inputSchema.properties.since.description, /comment id.*ISO timestamp/);
  const add = tools.find((tool: any) => tool.name === 'add');
  assert.match(add.inputSchema.properties.complexity.description, /Requires why \(min 20 chars\)/);
  assert.match(tools.find((tool: any) => tool.name === 'changes').description, /^THE polling read/);
  assert.deepEqual(Object.keys(comments.inputSchema.properties).sort(), ['cursor', 'full', 'limit', 'project', 'ref', 'since']);
  assert.equal(comments.inputSchema.properties.full.type, 'boolean');
  const ready = tools.find((tool: any) => tool.name === 'ready');
  assert.match(ready.description, /ref\/title/);
  assert.equal(ready.inputSchema.properties.full.type, 'boolean');
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

test('board_config stores read-only MCP deny patterns', async () => {
  const project = store.ensureProject(path.join(os.tmpdir(), 'sq-mcp-read-only-deny'), 'SQ read-only deny').slug;
  const patterns = ['mcp__notion__search', 'mcp__plugin_svelte_svelte__*'];
  const configured = await callTool('board_config', { project, readOnlyDeniedTools: patterns });
  assert.deepEqual(configured.readOnlyDeniedTools, patterns);
  assert.deepEqual((await callTool('board_config', { project })).readOnlyDeniedTools, patterns);
  const rejected = await callToolRaw('board_config', { project, readOnlyDeniedTools: ['Bash'] });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /must target MCP tools/);
});

test('board_config stores generated source-to-output pairs', async () => {
  const project = store.ensureProject(path.join(os.tmpdir(), 'sq-mcp-generated-pairs'), 'SQ generated pairs').slug;
  const pairs = [{ from: 'plugins/*/src/lib/*.ts', to: 'plugins/*/lib/*.js' }];
  assert.deepEqual((await callTool('board_config', { project, generatedPairs: pairs })).generatedPairs, pairs);
  assert.deepEqual((await callTool('board_config', { project })).generatedPairs, pairs);
  const rejected = await callToolRaw('board_config', { project, generatedPairs: [{ from: 'src/*.ts', to: 'lib/*.js*' }] });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /same number of \* placeholders/);
});

test('board_config defaults and stores the integration branch', async () => {
  const project = store.ensureProject(path.join(os.tmpdir(), 'sq-mcp-integration-branch'), 'SQ integration branch').slug;
  assert.equal((await callTool('board_config', { project })).integrationBranch, 'main');
  assert.equal((await callTool('board_config', { project, integrationBranch: 'feat/release' })).integrationBranch, 'feat/release');
  const rejected = await callToolRaw('board_config', { project, integrationBranch: 'feat//release' });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /integrationBranch must be a valid Git branch name/);
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

test('board_config sets the unintegrated worktree salvage age', async () => {
  const root = path.join(os.tmpdir(), 'sq-mcp-salvage-age');
  const project = store.ensureProject(root, 'SQ salvage age').slug;
  const configured = await callTool('board_config', { project, notIntegratedSalvageAgeHours: 336 });
  assert.equal(configured.notIntegratedSalvageAgeHours, 336);
  assert.equal(runCli(['board-config', '--project', root, '--not-integrated-salvage-age-hours', '504', '--json']).notIntegratedSalvageAgeHours, 504);
  await assert.rejects(() => callTool('board_config', { project, notIntegratedSalvageAgeHours: 24 }), /at least 168 hours/);
});

test('board worktree isolation defaults on and overrides dispatch isolation when disabled', async () => {
  const isolatedRoot = committedRepo('sq-mcp-worktree-isolation-default-');
  const isolatedProject = store.ensureProject(isolatedRoot, 'SQ default isolation').slug;
  assert.equal((await callTool('board_config', { project: isolatedProject })).worktreeIsolation, true);
  assert.equal((await callTool('board_config', { project: isolatedProject })).autoApproveTestScope, true);
  const isolatedTicket = store.createTicket(isolatedProject, {
    title: 'default board isolation', description: DISPATCH_DESCRIPTION, category: 'coding.normal', files: ['src/work.ts'],
  });
  const isolated = await callTool('dispatch', { project: isolatedProject, ref: isolatedTicket.ref, full: true });
  assert.equal(isolated.spawn.isolation, 'worktree');
  assert.equal(store.getTicket(isolatedProject, isolatedTicket.ref).dispatch.sharedTree, false);

  const scopeLessTicket = store.createTicket(isolatedProject, {
    title: 'scope-less default board isolation', description: DISPATCH_DESCRIPTION, category: 'coding.normal',
  });
  const scopeLess = await callTool('dispatch', { project: isolatedProject, ref: scopeLessTicket.ref, full: true });
  assert.equal(scopeLess.spawn.isolation, 'worktree');
  assert.equal(store.getTicket(isolatedProject, scopeLessTicket.ref).dispatch.sharedTree, false);

  const sharedRoot = committedRepo('sq-mcp-worktree-isolation-off-');
  const sharedProject = store.ensureProject(sharedRoot, 'SQ shared isolation').slug;
  const configured = await callTool('board_config', { project: sharedProject, worktreeIsolation: false });
  assert.equal(configured.worktreeIsolation, false);
  assert.equal((await callTool('board_config', { project: sharedProject })).worktreeIsolation, false);
  assert.equal(runCli(['board-config', '--project', sharedRoot, '--worktree-isolation', '--json'], sharedRoot).worktreeIsolation, true);
  assert.equal(runCli(['board-config', '--project', sharedRoot, '--no-worktree-isolation', '--json'], sharedRoot).worktreeIsolation, false);
  assert.equal(runCli(['board-config', '--project', sharedRoot, '--no-auto-approve-test-scope', '--json'], sharedRoot).autoApproveTestScope, false);
  assert.equal(runCli(['board-config', '--project', sharedRoot, '--auto-approve-test-scope', '--json'], sharedRoot).autoApproveTestScope, true);
  assert.deepEqual(runCli(['board-config', '--project', sharedRoot, '--auto-approve-scope', 'generated/**', '--auto-approve-scope', 'snapshots/**', '--json'], sharedRoot).autoApproveScope, ['generated/**', 'snapshots/**']);

  const sharedTicket = store.createTicket(sharedProject, {
    title: 'scope-less disabled board isolation', description: DISPATCH_DESCRIPTION, category: 'coding.normal',
  });
  const shared = await callTool('dispatch', { project: sharedProject, ref: sharedTicket.ref, full: true });
  assert.equal(shared.spawn.isolation, undefined);
  assert.equal(store.getTicket(sharedProject, sharedTicket.ref).dispatch.sharedTree, true);
  const legacyShared = await callHandler('native_agent', { project: sharedProject, ref: sharedTicket.ref, prompt: 'Implement the ticket.' });
  assert.equal(legacyShared.spawn.isolation, undefined);

  const overriddenTicket = store.createTicket(sharedProject, {
    title: 'forced shared tree', description: DISPATCH_DESCRIPTION, category: 'coding.normal', files: ['src/other.ts'],
  });
  const overridden = await callTool('dispatch', { project: sharedProject, ref: overriddenTicket.ref, sharedTree: false, full: true });
  assert.equal(overridden.spawn.isolation, undefined);
  assert.equal(store.getTicket(sharedProject, overriddenTicket.ref).dispatch.sharedTree, true);
  assert.match(store.getTicket(sharedProject, overriddenTicket.ref).dispatch.worktreeWarning, /explicit sharedTree:false was overridden/);
});


test('pulse exposes an immediate refused scope ruling', async () => {
  // Terge_VST, 2026-08-05: with no scope in pulse, the orchestrator shelled out to
  // `sidequest.js show <ref> --json` piped through python just to confirm a grant landed.
  const project = store.ensureProject(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-pulse-scope-'))).slug;
  const ticket = store.createTicket(project, {
    title: 'scope visible in pulse', files: ['lib/a.js'], complexity: 2,
    labels: ['direct-ok'], complexityWhy: 'the scope in force must be readable straight from pulse',
  });
  const by = 'pulse-scope-worker';
  assert.equal((await callTool('claim', { project, ref: ticket.ref, by, direct: true, reason: 'The pulse scope fixture requires a local direct claim.' })).ok, true);
  await callTool('scopeRequest', { project, ref: ticket.ref, by, files: ['lib/b.js'] });

  const ruled = await callTool('pulse', { project, ref: ticket.ref });
  assert.deepEqual(ruled.scope.files, ['lib/a.js']);
  assert.equal(ruled.scope.request, undefined);
  assert.equal(ruled.scope.lastRuling.state, 'refused');
  assert.deepEqual(ruled.scope.lastRuling.refused, ['lib/b.js']);
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
  const projectPath = path.join(os.tmpdir(), 'sq-mcp-payload-budget-');
  const project = store.ensureProject(projectPath).slug;
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(path.join(projectPath, 'fixture.ts'), 'export {};\n');
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
  assert.deepEqual(localCategory.route, { model: 'sonnet', effort: 'low' });
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

  const warningTicket = await callTool('add', { project, title: 'payload warning', description: DISPATCH_DESCRIPTION, category: 'debugging', files: ['fixture.ts'] });
  const warningDispatch = await callToolRaw('dispatch', { project, ref: warningTicket.ref });
  assert.ok(Buffer.byteLength(warningDispatch.content[0].text) <= 1200, `warning dispatch is ${Buffer.byteLength(warningDispatch.content[0].text)} bytes`);
  assert.equal(JSON.parse(warningDispatch.content[0].text).warnings, undefined);

  const pulse = await callToolRaw('pulse', { project, ref: ticket.ref });
  assert.ok(Buffer.byteLength(pulse.content[0].text) <= 1200, `pulse is ${Buffer.byteLength(pulse.content[0].text)} bytes`);
  const pulsePayload = JSON.parse(pulse.content[0].text);
  assert.equal(pulsePayload.submission, undefined);
  assert.equal(pulsePayload.git, undefined);
  assert.equal(pulsePayload.dispatch.tokenPrefix, undefined);

  for (const [name, args, maxBytes] of [
    ['list', { project }, 13000],
    ['comments', { project, ref: ticket.ref }, 13000],
    ['changes', { project }, 1200],
    ['ready', { project }, 1200],
    ['integrate', { project, ref: 'SQ-999999', by: 'payload-tester' }, 1200],
  ] as const) {
    const result = await callToolRaw(name, args);
    assert.ok(Buffer.byteLength(result.content[0].text) <= maxBytes, `${name} is ${Buffer.byteLength(result.content[0].text)} bytes`);
  }
});

test('integrate returns actionable post-merge verification failures', async () => {
  const project = store.ensureProject(committedRepo('sq-mcp-integrate-verify-failure-')).slug;
  const original = store.integrateSubmission;
  const verify = {
    status: 'failed',
    command: 'node --test failing-test.js',
    exitCode: 7,
    logPath: 'C:/tmp/integration-verify.log',
    outputTail: 'not ok 1 - integration verify failure',
  };
  store.integrateSubmission = () => ({
    ok: false,
    reason: 'verify_failed_post_merge',
    ticket: { ref: 'SQ-verify-failure', status: 'doing' },
    verify,
  });
  try {
    const result = await callHandler('integrate', { project, ref: 'SQ-verify-failure', by: 'payload-tester' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'verify_failed_post_merge');
    assert.deepEqual(result.verifyFailed, verify);
  } finally {
    store.integrateSubmission = original;
  }
});

test('integrate compacts successful verification output', async () => {
  const repo = committedRepo('sq-mcp-integrate-verify-success-');
  gitAt(repo, ['config', 'user.name', 'Sidequest Test']);
  gitAt(repo, ['config', 'user.email', 'sidequest-test@example.invalid']);
  fs.writeFileSync(path.join(repo, 'verify-summary.cjs'), "console.log('ok 1 - verification'); console.log('1..1'); console.log('# tests 1'); console.log('# pass 1'); console.log('# fail 0'); console.log('# skipped 0'); console.log('# duration_ms 12.5');\n");
  gitAt(repo, ['add', 'verify-summary.cjs']);
  gitAt(repo, ['commit', '-m', 'verification fixture']);
  const project = store.ensureProject(repo).slug;
  const base = gitAt(repo, ['rev-parse', 'HEAD']);
  const ticket = store.createTicket(project, {
    title: 'compact successful integration output',
    category: 'codebase-exploration',
    description: 'Verify that successful integration output stays small.',
    files: ['feature.txt'],
  });
  gitAt(repo, ['checkout', '-b', 'submission']);
  fs.writeFileSync(path.join(repo, 'feature.txt'), 'submitted\n');
  gitAt(repo, ['add', 'feature.txt']);
  gitAt(repo, ['commit', '-m', 'submission fixture']);
  const commit = gitAt(repo, ['rev-parse', 'HEAD']);
  const gitRef = `refs/sidequest/${ticket.ref}`;
  gitAt(repo, ['update-ref', gitRef, commit]);
  gitAt(repo, ['checkout', 'main']);
  const verify = `"${process.execPath}" verify-summary.cjs`;
  const submitted = store.submitTicket(project, ticket.ref, 'fixture-worker', {
    commit,
    gitRef,
    range: {
      base,
      upstream: 'main',
      upstreamCommit: base,
      commits: [commit],
      changedPaths: ['feature.txt'],
      integrationMode: 'local',
      integrationBranch: 'main',
    },
    worktree: repo,
    verify,
    force: true,
  });
  assert.equal(submitted.ok, true);

  const result = await callHandler('integrate', { project, ref: ticket.ref, by: 'payload-tester' });
  const payload = JSON.stringify(result);
  assert.equal(result.ok, true);
  assert.equal(result.verify.status, 'passed');
  assert.match(fs.readFileSync(result.verify.logPath, 'utf8'), /^# tests 1$/m);
  assert.equal(result.verify.summary.total, 1);
  assert.equal(result.verify.summary.pass, 1);
  assert.equal(result.verify.summary.fail, 0);
  assert.equal(result.verify.summary.skipped, 0);
  assert.equal(typeof result.verify.summary.durationMs, 'number');
  assert.ok(result.verify.logPath);
  assert.equal(result.verify.outputTail, undefined);
  assert.equal(result.delivery.verify, undefined);
  assert.equal((payload.match(/"verify"\s*:/g) || []).length, 1);
  assert.equal(payload.includes('ok 1 - verification'), false);
});

test('verify commands reject direct multi-plugin directory chaining', () => {
  const project = store.ensureProject(path.join(os.tmpdir(), 'sq-mcp-multi-plugin-verify-')).slug;
  assert.throws(() => store.createTicket(project, {
    title: 'unsafe multi-plugin verify',
    executorVerify: 'cd plugins/sidequest && npm test; cd plugins/playbook && npm test',
  }), /Verify cannot use `;` command chaining/);
  assert.doesNotThrow(() => store.createTicket(project, {
    title: 'safe multi-plugin verify',
    executorVerify: '(cd plugins/sidequest && npm test) && (cd plugins/playbook && npm test)',
  }));
});

test('dispatch warns about external output outside the repo worktree', async () => {
  const project = store.ensureProject(committedRepo('sq-mcp-dispatch-external-')).slug;
  const outside = path.join(os.tmpdir(), `sq-mcp-dispatch-audition-${process.pid}.html`);
  const scope = outside.replace(/\\/g, '/');
  const target = await callTool('add', {
    project,
    title: 'external dispatch output',
    description: DISPATCH_DESCRIPTION,
    category: 'general',
    files: [scope],
  });

  const dispatched = await callTool('dispatch', { project, ref: target.ref, full: true });

  assert.deepEqual(dispatched.warnings, [
    `Dispatch warning: declared paths are outside the repo worktree: ${scope}. A repo-changing category can't commit them. Use an artifact/non-repo category, or declare in-repo paths.`,
  ]);
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
    `Dispatch warning: ${target.ref} overlaps in-flight ${inFlight.ref} at src/lib.rs — parallel is fine in isolated worktrees unless the same symbols/regions change; assess.`,
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
    `Dispatch warning: ${target.ref} overlaps in-flight ${inFlight.ref} at Cargo.lock — parallel is fine in isolated worktrees unless the same symbols/regions change; assess. Only lockfiles overlap; serialize these tickets or regenerate the lockfile at integration.`,
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

test('MCP comments returns only entries appended after a prior comment id', async () => {
  const project = store.ensureProject(path.join(os.tmpdir(), 'sq-mcp-comment-since-')).slug;
  const ticket = store.createTicket(project, { title: 'comment since fixture' });
  assert.equal(store.addComment(project, ticket.ref, { body: 'first handoff', by: 'first-worker', kind: 'comment', source: 'mcp' }).ok, true);

  const firstRead = await callTool('comments', { project, ref: ticket.ref });
  const firstComment = firstRead.comments.at(-1);
  assert.ok(firstComment?.id);
  assert.equal(store.addComment(project, ticket.ref, { body: 'second handoff', by: 'second-worker', kind: 'comment', source: 'mcp' }).ok, true);

  const incremental = await callTool('comments', { project, ref: ticket.ref, since: firstComment.id });
  assert.deepEqual(incremental.comments.map((comment: any) => comment.body), ['second handoff']);
  assert.deepEqual(
    { total: incremental.total, returned: incremental.returned, nextCursor: incremental.nextCursor, order: incremental.order },
    { total: 2, returned: 1, nextCursor: null, order: 'chronological' },
  );

  const quiet = await callTool('comments', { project, ref: ticket.ref, since: incremental.comments[0].id });
  assert.deepEqual(quiet.comments, []);
  assert.deepEqual(
    { total: quiet.total, returned: quiet.returned, nextCursor: quiet.nextCursor, order: quiet.order },
    { total: 2, returned: 0, nextCursor: null, order: 'chronological' },
  );

  const timestamp = new Date(Date.parse(firstComment.at) - 1).toISOString();
  const timestampRead = await callTool('comments', { project, ref: ticket.ref, since: timestamp });
  assert.deepEqual(timestampRead.comments.map((comment: any) => comment.body), ['first handoff', 'second handoff']);
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

  const missingReport = await callToolRaw('submit', {
    project, ref: ticket.ref, by, commit: committed.commit, worktree: explicitPath,
  });
  assert.ok(missingReport.isError, 'submit refuses a missing final report');
  assert.match(missingReport.content[0].text, /"body" is required.*final report/i);
  assert.ok(store.getTicket(project, ticket.ref).claim, 'a missing report keeps the claim');
  gitAt(worktree, ['reset', '--', 'foreign.js']);
  fs.unlinkSync(path.join(worktree, 'foreign.js'));

  const requested = await callTool('scopeRequest', { project, ref: ticket.ref, by, files: ['foreign/denied.js'] });
  assert.equal(requested.state, 'refused');
  assert.deepEqual(requested.refused, ['foreign/denied.js']);

  const finalReport = `MCP terminal evidence ${'x'.repeat(1600)}`;
  const submitted = await callTool('submit', {
    project, ref: ticket.ref, by, commit: committed.commit,
    worktree: explicitPath, verify: 'node --test plugins/sidequest/test/mcp.test.js',
    body: finalReport,
  });
  assert.equal(submitted.ok, true);
  assert.equal(submitted.submission, undefined, 'submit acknowledgement omits stored submission details');
  assert.equal(store.getTicket(project, ticket.ref).submission.commit, committed.commit);
  const after = store.getTicket(project, ticket.ref);
  assert.equal(after.claim, null, 'submit releases the claim');
  const reportComment = after.comments.find((comment: any) => comment.body === finalReport);
  assert.equal(after.submission.commentId, reportComment.id);
  const comments = await callTool('comments', { project, ref: ticket.ref });
  const reportRead = comments.comments.find((comment: any) => comment.id === reportComment.id);
  assert.equal(reportRead.body, finalReport, 'the newest executor final report remains verbatim');
  assert.equal(reportRead.bodyTruncated, false);

  const malformed = store.createTicket(project, {
    title: 'MCP malformed submission', files: ['lib/other.js'], complexity: 3,
    labels: ['direct-ok'],
    complexityWhy: 'confirm malformed MCP submission input preserves the ticket claim',
  });
  assert.equal((await callTool('claim', { project, ref: malformed.ref, by: 'mcp-bad-worker', direct: true, reason: 'The malformed submission fixture requires a direct claim.' })).ok, true);
  const bad = await callToolRaw('submit', { project, ref: malformed.ref, by: 'mcp-bad-worker', commit: 'not-a-hash', worktree, body: 'Malformed submission evidence' });
  assert.ok(bad.isError, 'malformed hashes fail before a board write');
  assert.ok(store.getTicket(project, malformed.ref).claim, 'malformed submission keeps the claim');
});

test('MCP submit requires release fragments for marketplace plugin changes', async () => {
  const missingWorktree = createGitWorktree();
  addMarketplaceFixture(missingWorktree);
  const missingProject = store.ensureProject(missingWorktree).slug;
  const missing = store.createTicket(missingProject, {
    title: 'missing release fragment', files: ['plugins/fixture-plugin'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'confirm shipped plugin changes require an authored release fragment',
  });
  const missingBy = 'mcp-release-fragment-worker';
  assert.equal((await callTool('claim', { project: missingProject, ref: missing.ref, by: missingBy, direct: true, reason: 'The release fragment fixture requires a local direct claim.' })).ok, true);
  fs.mkdirSync(path.join(missingWorktree, 'plugins', 'fixture-plugin'), { recursive: true });
  fs.writeFileSync(path.join(missingWorktree, 'plugins', 'fixture-plugin', 'index.js'), 'changed\n');
  gitAt(missingWorktree, ['add', 'plugins/fixture-plugin/index.js']);
  gitAt(missingWorktree, ['commit', '-m', 'plugin change without fragment']);
  const missingCommit = gitAt(missingWorktree, ['rev-parse', 'HEAD']);
  gitAt(missingWorktree, ['update-ref', `refs/sidequest/${missing.ref}`, missingCommit]);
  const refused = await callTool('submit', {
    project: missingProject, ref: missing.ref, by: missingBy, commit: missingCommit, worktree: missingWorktree, body: 'Missing fragment evidence',
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'missing_release_fragment');
  assert.match(refused.message, new RegExp(`Create it with:\\n---\\nref: ${missing.ref}`));
  assert.doesNotMatch(refused.message, /Request scope/);
  assert.match(refused.message, /ref: .*\ntitle: <short user-facing title>\nbump: patch\nplugins:/);
  assert.ok(store.getTicket(missingProject, missing.ref).claim, 'fragment refusal keeps the claim');

  const docsWorktree = createGitWorktree();
  addMarketplaceFixture(docsWorktree);
  const docsProject = store.ensureProject(docsWorktree).slug;
  const docs = store.createTicket(docsProject, {
    title: 'docs-only submission', files: ['docs'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'confirm a marketplace fixture does not block unrelated documentation work',
  });
  const docsBy = 'mcp-docs-worker';
  assert.equal((await callTool('claim', { project: docsProject, ref: docs.ref, by: docsBy, direct: true, reason: 'The docs-only fixture requires a local direct claim.' })).ok, true);
  fs.mkdirSync(path.join(docsWorktree, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(docsWorktree, 'docs', 'guide.md'), 'docs\n');
  gitAt(docsWorktree, ['add', 'docs/guide.md']);
  gitAt(docsWorktree, ['commit', '-m', 'docs change']);
  const docsCommit = gitAt(docsWorktree, ['rev-parse', 'HEAD']);
  gitAt(docsWorktree, ['update-ref', `refs/sidequest/${docs.ref}`, docsCommit]);
  assert.equal((await callTool('submit', {
    project: docsProject, ref: docs.ref, by: docsBy, commit: docsCommit, worktree: docsWorktree, body: 'Docs-only evidence',
  })).ok, true);

  const fragmentWorktree = createGitWorktree();
  addMarketplaceFixture(fragmentWorktree);
  const fragmentProject = store.ensureProject(fragmentWorktree).slug;
  const fragment = store.createTicket(fragmentProject, {
    title: 'plugin submission with release fragment', files: ['plugins/fixture-plugin'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'confirm a shipped plugin change can include its ticket-bound fragment without declared release scope',
  });
  const fragmentBy = 'mcp-valid-fragment-worker';
  assert.equal((await callTool('claim', { project: fragmentProject, ref: fragment.ref, by: fragmentBy, direct: true, reason: 'The valid release fragment fixture requires a local direct claim.' })).ok, true);
  fs.mkdirSync(path.join(fragmentWorktree, 'plugins', 'fixture-plugin'), { recursive: true });
  fs.mkdirSync(path.join(fragmentWorktree, '.release', 'unreleased'), { recursive: true });
  fs.writeFileSync(path.join(fragmentWorktree, 'plugins', 'fixture-plugin', 'index.js'), 'changed\n');
  fs.writeFileSync(path.join(fragmentWorktree, '.release', 'unreleased', `${fragment.ref}.md`), `---\nref: ${fragment.ref}\ntitle: Fixture change\nbump: patch\nplugins:\n  - fixture-plugin\n---\n\nFixture change.\n`);
  gitAt(fragmentWorktree, ['add', 'plugins/fixture-plugin/index.js', `.release/unreleased/${fragment.ref}.md`]);
  assert.deepEqual(store.effectiveScope(fragmentProject, fragment.files), ['plugins/fixture-plugin'], 'ordinary scope reporting excludes the ticket-bound grant');
  const fragmentCommit = await callTool('commit', {
    project: fragmentProject, ref: fragment.ref, by: fragmentBy, message: 'plugin change with fragment', worktree: fragmentWorktree,
  });
  assert.ok(fragmentCommit.commit, 'a ticket can commit its own release fragment without declaring it');
  gitAt(fragmentWorktree, ['update-ref', `refs/sidequest/${fragment.ref}`, fragmentCommit.commit]);
  assert.equal((await callTool('submit', {
    project: fragmentProject, ref: fragment.ref, by: fragmentBy, commit: fragmentCommit.commit, worktree: fragmentWorktree, body: 'Valid fragment evidence',
  })).ok, true);
  assert.deepEqual(store.getTicket(fragmentProject, fragment.ref).submission.admittedScope, ['plugins/fixture-plugin']);
  assert.equal(store.validateIntegrationSubmission(fragmentProject, fragment.ref, {}).ok, true, 'integration revalidation admits only the matching ticket fragment');

  const foreignWorktree = createGitWorktree();
  addMarketplaceFixture(foreignWorktree);
  const foreignProject = store.ensureProject(foreignWorktree).slug;
  const foreign = store.createTicket(foreignProject, {
    title: 'other release fragment', files: ['plugins/fixture-plugin'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'confirm a ticket cannot write another ticket release fragment',
  });
  const foreignBy = 'mcp-foreign-fragment-worker';
  assert.equal((await callTool('claim', { project: foreignProject, ref: foreign.ref, by: foreignBy, direct: true, reason: 'The foreign release fragment fixture requires a local direct claim.' })).ok, true);
  fs.mkdirSync(path.join(foreignWorktree, 'plugins', 'fixture-plugin'), { recursive: true });
  fs.mkdirSync(path.join(foreignWorktree, '.release', 'unreleased'), { recursive: true });
  fs.writeFileSync(path.join(foreignWorktree, 'plugins', 'fixture-plugin', 'index.js'), 'changed\n');
  fs.writeFileSync(path.join(foreignWorktree, '.release', 'unreleased', 'SQ-other.md'), 'foreign\n');
  gitAt(foreignWorktree, ['add', 'plugins/fixture-plugin/index.js', '.release/unreleased/SQ-other.md']);
  const foreignCommit = await callTool('commit', {
    project: foreignProject, ref: foreign.ref, by: foreignBy, message: 'foreign release fragment', worktree: foreignWorktree,
  });
  assert.equal(foreignCommit.ok, false);
  assert.equal(foreignCommit.reason, 'outside_scope');
  assert.match(foreignCommit.message, new RegExp(`only \\.release/unreleased/${foreign.ref}\\.md is implicitly writable`));
});

test('MCP submit reports every independently fixable completion refusal together', async () => {
  const worktree = createGitWorktree();
  addMarketplaceFixture(worktree);
  const project = store.ensureProject(worktree).slug;
  const ticket = store.createTicket(project, {
    title: 'batched submission refusals',
    description: DISPATCH_DESCRIPTION,
    category: 'coding.normal',
    files: ['plugins/fixture-plugin'],
    executorVerify: 'node --test plugins/fixture-plugin/test/declared.test.js',
  });
  const by = 'mcp-batched-refusal-worker';
  claimDispatchedTicket(project, ticket, by, true);
  fs.mkdirSync(path.join(worktree, 'plugins', 'fixture-plugin', 'test'), { recursive: true });
  fs.writeFileSync(path.join(worktree, 'plugins', 'fixture-plugin', 'index.js'), 'module.exports = true;\n');
  fs.writeFileSync(path.join(worktree, 'plugins', 'fixture-plugin', 'test', 'index.test.js'), 'module.exports = true;\n');
  gitAt(worktree, ['add', 'plugins/fixture-plugin']);
  gitAt(worktree, ['commit', '-m', 'batched refusal fixture']);
  const commit = gitAt(worktree, ['rev-parse', 'HEAD']);
  gitAt(worktree, ['update-ref', `refs/sidequest/${ticket.ref}`, commit]);

  const refused = await callTool('submit', {
    project,
    ref: ticket.ref,
    by,
    commit,
    worktree,
    verify: 'node --test plugins/fixture-plugin/test/other.test.js',
    body: 'Batched refusal evidence.',
  });

  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'missing_release_fragment');
  assert.deepEqual(refused.failures.map((failure: any) => failure.reason), [
    'missing_release_fragment',
    'negative_control_required',
    'executor_verify_mismatch',
  ]);
  assert.match(refused.message, /Create it with:/);
  assert.match(refused.message, /has not recorded a negative control/);
  assert.match(refused.message, /must match the declared executor verify command/);
});

test('MCP add reports every verify-command defect together', async () => {
  const refused = await callTool('add', {
    title: 'batched verify command refusal',
    unclassified: true,
    verify: 'check test; npm run test',
  });

  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'invalid_verify');
  assert.equal(refused.failures.length, 2);
  assert.match(refused.failures[0].message, /cannot use `;`/);
  assert.match(refused.failures[1].message, /must start with a runnable command/);
});

test('CLI submit requires release fragments for marketplace plugin changes', async () => {
  const missingWorktree = createGitWorktree();
  addMarketplaceFixture(missingWorktree);
  const missingProject = store.ensureProject(missingWorktree).slug;
  const missing = store.createTicket(missingProject, {
    title: 'CLI missing release fragment', files: ['plugins/fixture-plugin'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'confirm CLI submissions require an authored release fragment',
  });
  const missingBy = 'cli-release-fragment-worker';
  assert.equal((await callTool('claim', { project: missingProject, ref: missing.ref, by: missingBy, direct: true, reason: 'The CLI release fragment fixture requires a local direct claim.' })).ok, true);
  fs.mkdirSync(path.join(missingWorktree, 'plugins', 'fixture-plugin'), { recursive: true });
  fs.writeFileSync(path.join(missingWorktree, 'plugins', 'fixture-plugin', 'index.js'), 'changed\n');
  gitAt(missingWorktree, ['add', 'plugins/fixture-plugin/index.js']);
  gitAt(missingWorktree, ['commit', '-m', 'CLI plugin change without fragment']);
  const missingCommit = gitAt(missingWorktree, ['rev-parse', 'HEAD']);
  gitAt(missingWorktree, ['update-ref', `refs/sidequest/${missing.ref}`, missingCommit]);
  const refused = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'sidequest.js'), 'submit', missing.ref, '--project', missingProject, '--by', missingBy, '--commit', missingCommit, '--worktree', missingWorktree, '--verify', 'node --test plugins/sidequest/test/mcp.test.js', '--body', 'Missing fragment evidence'], {
    cwd: missingWorktree, encoding: 'utf8', windowsHide: true,
    env: Object.assign({}, process.env, { SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: PROJ }),
  });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, new RegExp(`Create it with:\\n---\\nref: ${missing.ref}`));
  assert.doesNotMatch(refused.stderr, /Request scope/);
  assert.ok(store.getTicket(missingProject, missing.ref).claim, 'CLI fragment refusal keeps the claim');

  const docsWorktree = createGitWorktree();
  addMarketplaceFixture(docsWorktree);
  const docsProject = store.ensureProject(docsWorktree).slug;
  const docs = store.createTicket(docsProject, {
    title: 'CLI docs-only submission', files: ['docs'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'confirm CLI docs-only submissions remain admitted',
  });
  const docsBy = 'cli-docs-worker';
  assert.equal((await callTool('claim', { project: docsProject, ref: docs.ref, by: docsBy, direct: true, reason: 'The CLI docs-only fixture requires a local direct claim.' })).ok, true);
  fs.mkdirSync(path.join(docsWorktree, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(docsWorktree, 'docs', 'guide.md'), 'docs\n');
  gitAt(docsWorktree, ['add', 'docs/guide.md']);
  gitAt(docsWorktree, ['commit', '-m', 'CLI docs change']);
  const docsCommit = gitAt(docsWorktree, ['rev-parse', 'HEAD']);
  gitAt(docsWorktree, ['update-ref', `refs/sidequest/${docs.ref}`, docsCommit]);
  assert.equal(runCli(['submit', docs.ref, '--project', docsProject, '--by', docsBy, '--commit', docsCommit, '--worktree', docsWorktree, '--verify', 'node --test plugins/sidequest/test/mcp.test.js', '--body', 'CLI docs evidence', '--json'], docsWorktree).ok, true);

  const fragmentWorktree = createGitWorktree();
  addMarketplaceFixture(fragmentWorktree);
  const fragmentProject = store.ensureProject(fragmentWorktree).slug;
  const fragment = store.createTicket(fragmentProject, {
    title: 'CLI plugin submission with release fragment', files: ['plugins/fixture-plugin'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'confirm CLI plugin submissions can commit their ticket-bound fragment without declared release scope',
  });
  const fragmentBy = 'cli-valid-fragment-worker';
  assert.equal((await callTool('claim', { project: fragmentProject, ref: fragment.ref, by: fragmentBy, direct: true, reason: 'The CLI valid fragment fixture requires a local direct claim.' })).ok, true);
  fs.mkdirSync(path.join(fragmentWorktree, 'plugins', 'fixture-plugin'), { recursive: true });
  fs.mkdirSync(path.join(fragmentWorktree, '.release', 'unreleased'), { recursive: true });
  fs.writeFileSync(path.join(fragmentWorktree, 'plugins', 'fixture-plugin', 'index.js'), 'changed\n');
  fs.writeFileSync(path.join(fragmentWorktree, '.release', 'unreleased', `${fragment.ref}.md`), `---\nref: ${fragment.ref}\ntitle: Fixture change\nbump: patch\nplugins:\n  - fixture-plugin\n---\n\nFixture change.\n`);
  gitAt(fragmentWorktree, ['add', 'plugins/fixture-plugin/index.js', `.release/unreleased/${fragment.ref}.md`]);
  const fragmentCommit = runCli(['commit', fragment.ref, '--project', fragmentProject, '--by', fragmentBy, '--message', 'CLI plugin change with fragment', '--json'], fragmentWorktree).commit;
  assert.ok(fragmentCommit, 'CLI commit admits the ticket-bound fragment without declared release scope');
  gitAt(fragmentWorktree, ['update-ref', `refs/sidequest/${fragment.ref}`, fragmentCommit]);
  assert.equal(runCli(['submit', fragment.ref, '--project', fragmentProject, '--by', fragmentBy, '--commit', fragmentCommit, '--worktree', fragmentWorktree, '--verify', 'node --test plugins/sidequest/test/mcp.test.js', '--body', 'CLI valid fragment evidence', '--json'], fragmentWorktree).ok, true);
  assert.deepEqual(store.getTicket(fragmentProject, fragment.ref).submission.admittedScope, ['plugins/fixture-plugin']);
  assert.equal(store.validateIntegrationSubmission(fragmentProject, fragment.ref, {}).ok, true);
});


test('MCP commit and submit accept an 8.3 worktree alias', { skip: process.platform !== 'win32' }, async (context: any) => {
  const worktree = createGitWorktree();
  const alias = windowsShortPath(worktree);
  if (alias.toLowerCase() === worktree.toLowerCase()) {
    context.skip('8.3 aliases are unavailable on this volume');
    return;
  }
  const project = store.ensureProject(worktree).slug;
  const ticket = store.createTicket(project, {
    title: 'MCP 8.3 worktree alias', files: ['lib/allowed.js'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'exercise canonical worktree root matching',
  });
  const by = 'mcp-8dot3-worker';
  assert.equal((await callTool('claim', { project, ref: ticket.ref, by, direct: true, reason: 'The 8.3 alias fixture requires a local direct claim.' })).ok, true);

  fs.mkdirSync(path.join(worktree, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(worktree, 'lib', 'allowed.js'), 'allowed\n');
  gitAt(worktree, ['add', 'lib/allowed.js']);
  const committed = await callTool('commit', {
    project, ref: ticket.ref, by, message: 'MCP 8.3 alias commit', worktree: alias,
  });
  gitAt(worktree, ['update-ref', `refs/sidequest/${ticket.ref}`, committed.commit]);
  const submitted = await callTool('submit', {
    project, ref: ticket.ref, by, commit: committed.commit, worktree: alias,
    body: 'MCP 8.3 alias submission evidence',
  });
  assert.equal(submitted.ok, true);
});

test('MCP commit refuses an isolated dispatch in the primary worktree but permits linked and shared trees', async () => {
  const primary = createGitWorktree();
  const project = store.ensureProject(primary).slug;
  const isolated = store.createTicket(project, {
    title: 'isolated commit guard', description: DISPATCH_DESCRIPTION, category: 'coding.normal', files: ['lib/guarded.js'],
  });
  const isolatedBy = 'mcp-isolated-guard-worker';
  claimDispatchedTicket(project, isolated, isolatedBy);

  fs.mkdirSync(path.join(primary, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(primary, 'lib', 'guarded.js'), 'primary\n');
  gitAt(primary, ['add', 'lib/guarded.js']);
  const primaryHead = gitAt(primary, ['rev-parse', 'HEAD']);
  const refused = await callTool('commit', {
    project, ref: isolated.ref, by: isolatedBy, message: 'must not commit in primary', worktree: primary,
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'worktree_isolation');
  assert.match(refused.message, /requires a linked worktree/);
  assert.equal(gitAt(primary, ['rev-parse', 'HEAD']), primaryHead, 'primary worktree remains uncommitted');

  const linked = createLinkedWorktree(primary);
  fs.mkdirSync(path.join(linked, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(linked, 'lib', 'guarded.js'), 'linked\n');
  gitAt(linked, ['add', 'lib/guarded.js']);
  const committed = await callTool('commit', {
    project, ref: isolated.ref, by: isolatedBy, message: 'commit from linked worktree', worktree: linked,
  });
  assert.ok(committed.commit, 'isolated dispatch can commit from a linked worktree');

  const shared = store.createTicket(project, {
    title: 'shared commit exemption', description: DISPATCH_DESCRIPTION, category: 'coding.normal', files: ['lib/shared.js'],
  });
  const sharedBy = 'mcp-shared-guard-worker';
  claimDispatchedTicket(project, shared, sharedBy, true);
  fs.writeFileSync(path.join(primary, 'lib', 'shared.js'), 'shared\n');
  gitAt(primary, ['add', 'lib/shared.js']);
  const sharedCommit = await callTool('commit', {
    project, ref: shared.ref, by: sharedBy, message: 'shared tree commit', worktree: primary,
  });
  assert.ok(sharedCommit.commit, 'shared-tree dispatch can commit from the primary worktree');
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
  assert.equal((await callTool('submit', { project, ref: first.ref, by: 'mcp-base-worker', commit: firstTip, worktree, body: 'MCP explicit-base evidence' })).ok, true);

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
    project, ref: second.ref, by: 'mcp-dependent-worker', commit: secondTip, base: firstTip, worktree, body: 'MCP dependent-range evidence',
  });
  assert.equal(submitted.ok, true);
  const submission = store.getTicket(project, second.ref).submission;
  assert.equal(submission.base, firstTip);
  assert.deepEqual(submission.commits, [secondTip]);
  assert.deepEqual(submission.changedPaths, ['lib/second.js']);
});

test('MCP commit explains external-output recovery', async () => {
  const worktree = createGitWorktree();
  const project = store.ensureProject(worktree).slug;
  const outside = path.join(os.tmpdir(), `sq-mcp-external-output-${process.pid}.html`);
  const ticket = store.createTicket(project, {
    title: 'MCP external output', files: [outside], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'confirm external output commit refusal names the recovery path',
  });
  const by = 'mcp-external-output-worker';
  assert.equal((await callTool('claim', { project, ref: ticket.ref, by, direct: true, reason: 'The external output fixture requires a local direct claim.' })).ok, true);

  const refused = await callTool('commit', { project, ref: ticket.ref, by, message: 'MCP external output', worktree });

  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'outside_scope');
  assert.match(refused.message, /declared paths are outside the repo worktree/i);
  assert.match(refused.message, /release and reclassify as non-repo\/artifact work/i);
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
  const refused = await callTool('submit', { project, ref: ticket.ref, by, commit, worktree, body: 'MCP scope refusal evidence' });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'outside_scope');
  assert.match(refused.message, new RegExp(`sidequest update ${ticket.ref} --files`));
  assert.ok(store.getTicket(project, ticket.ref).claim, 'scope refusal keeps the claim');
});

function repoWithDirectories(prefix: string, directories: string[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const directory of directories) fs.mkdirSync(path.join(root, directory), { recursive: true });
  return root;
}


// A flat repo is the common case outside this marketplace, and it is where the
// policy kept failing to fire: the ticket declares source, needs to register a
// new suite in tests/, and the run stops on a directory nobody thought to name.

test('MCP scopeRequest derives build registration from a new in-scope source file', async () => {
  const root = repoWithDirectories('sq-mcp-build-registration-', ['src/plugin']);
  fs.writeFileSync(path.join(root, 'CMakeLists.txt'), 'add_library(plugin)\n');
  const project = store.ensureProject(root).slug;
  const ticket = store.createTicket(project, {
    title: 'Register graph parameters', files: ['src/plugin/graph_parameters.cpp'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'the new source needs the governing CMake registration to build',
  });
  const by = 'mcp-build-registration-worker';
  assert.equal((await callTool('claim', { project, ref: ticket.ref, by, direct: true, reason: 'The scope fixture requires a local direct claim.' })).ok, true);

  const approved = await callTool('scopeRequest', { project, ref: ticket.ref, by, files: ['CMakeLists.txt'] });
  assert.equal(approved.autoApproved, true);
  assert.deepEqual(approved.approved, ['CMakeLists.txt']);
  assert.deepEqual(store.getTicket(project, ticket.ref).files, ['src/plugin/graph_parameters.cpp', 'CMakeLists.txt']);
  assert.match(store.getTicket(project, ticket.ref).comments.at(-1).body, /build-registration scope derived/);
});

test('MCP scopeRequest derives barrel registration without widening past the governing file', async () => {
  const root = repoWithDirectories('sq-mcp-barrel-registration-', ['src/models']);
  fs.writeFileSync(path.join(root, 'src/models/index.ts'), 'export {};\n');
  const project = store.ensureProject(root).slug;
  const ticket = store.createTicket(project, {
    title: 'Export widget model', files: ['src/models/widget.ts'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'the new model requires its local barrel export',
  });
  const by = 'mcp-barrel-registration-worker';
  assert.equal((await callTool('claim', { project, ref: ticket.ref, by, direct: true, reason: 'The scope fixture requires a local direct claim.' })).ok, true);

  const approved = await callTool('scopeRequest', { project, ref: ticket.ref, by, files: ['src/models/index.ts'] });
  assert.deepEqual(approved.approved, ['src/models/index.ts']);
  assert.deepEqual(store.getTicket(project, ticket.ref).files, ['src/models/widget.ts', 'src/models/index.ts']);
});




test('MCP scopeRequest auto-approves a concrete path inside the declared plugin without ending the attempt', async () => {
  const fixture = isolatedDispatch('sq-mcp-package-scope-', 'a1384package', ['plugins/sidequest/src/lib/store/tickets.ts']);
  const requestedFile = 'plugins/sidequest/src/lib/store/dispatch.ts';

  const approved = await callTool('scopeRequest', {
    project: fixture.project,
    ref: fixture.ref,
    by: fixture.by,
    files: [requestedFile],
  });

  assert.equal(approved.autoApproved, true);
  assert.deepEqual(approved.approved, [requestedFile]);
  assert.equal(approved.scopeRequest, null);
  const ticket = store.getTicket(fixture.project, fixture.ref);
  assert.deepEqual(ticket.files, ['plugins/sidequest/src/lib/store/tickets.ts', requestedFile]);
  assert.equal(ticket.scopeResolution.state, 'granted');
  assert.deepEqual(ticket.scopeResolution.requested, [requestedFile]);
  assert.deepEqual(ticket.scopeResolution.granted, [requestedFile]);
  assert.match(ticket.comments.at(-1).body, /same-package scope derived from the ticket’s declared files/);
  assert.equal(ticket.dispatch.outcome, 'claimed');
  assert.equal(ticket.dispatch.terminalAt, null);
  assert.equal(ticket.dispatch.scopeRequest, undefined);
  assert.equal(ticket.dispatch.attempts, undefined);
});


test('MCP scopeRequest keeps declared bundled hook output one-way: the source needs approval, the source grants its output', async () => {
  const worktree = createGitWorktree();
  const source = 'plugins/sidequest/src/hooks/subagent-stop.ts';
  const output = 'plugins/sidequest/hooks/subagent-stop.js';
  for (const file of [source, output, 'plugins/sidequest/scripts/build.mjs']) {
    fs.mkdirSync(path.dirname(path.join(worktree, file)), { recursive: true });
  }
  fs.writeFileSync(path.join(worktree, source), 'export const stop = true;\n');
  fs.writeFileSync(path.join(worktree, output), 'module.exports = { stop: true };\n');
  fs.writeFileSync(path.join(worktree, 'plugins', 'sidequest', 'scripts', 'build.mjs'), [
    'export const bundledBuildOutputs = [{',
    "  sourceDirectory: 'src/hooks',",
    "  outputDirectory: 'hooks',",
    "  sourceExtension: '.ts',",
    "  outputExtension: '.js',",
    '}];',
  ].join('\n'));
  fs.writeFileSync(path.join(worktree, 'plugins', 'sidequest', 'package.json'), JSON.stringify({ scripts: { build: 'node scripts/build.mjs' } }));
  gitAt(worktree, ['add', '.']);
  gitAt(worktree, ['commit', '-m', 'generated scope fixture']);
  const project = store.ensureProject(worktree).slug;
  const outputOnly = store.createTicket(project, {
    title: 'Generated hook output scope', files: ['plugins/sidequest/hooks'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'editing generated output without its source is a mistake worth an approval round trip',
  });
  const by = 'mcp-generated-output-scope-worker';
  assert.equal((await callTool('claim', { project, ref: outputOnly.ref, by, direct: true, reason: 'The generated scope fixture requires a local direct claim.' })).ok, true);

  const sourceRequest = await callTool('scopeRequest', { project, ref: outputOnly.ref, by, files: [source] });
  assert.deepEqual(sourceRequest.covered, [], 'declared output must not admit its source without approval');
  assert.equal(sourceRequest.state, 'refused');
  assert.deepEqual(sourceRequest.refused, [source]);

  const sourceDeclared = store.createTicket(project, {
    title: 'Declared source grants output', files: [source], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'a declared source implies its compiled output without a round trip',
  });
  const sourceBy = 'mcp-generated-source-scope-worker';
  assert.equal((await callTool('claim', { project, ref: sourceDeclared.ref, by: sourceBy, direct: true, reason: 'The generated scope fixture requires a local direct claim.' })).ok, true);
  const outputCovered = await callTool('scopeRequest', { project, ref: sourceDeclared.ref, by: sourceBy, files: [output] });
  assert.deepEqual(outputCovered.covered, [output], 'a declared source grants its tracked compiled output');
  assert.equal(outputCovered.state, 'granted');
});








test('MCP update makes control-plane scope approval discoverable and guards executor scope rewrites', async () => {
  const project = store.ensureProject(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-scope-update-'))).slug;
  const ticket = store.createTicket(project, {
    title: 'MCP active claim scope update', files: ['lib/allowed.js'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'claimed executors cannot rewrite their declared scope',
  });
  const by = 'mcp-active-scope-worker';
  assert.equal((await callTool('claim', { project, ref: ticket.ref, by, direct: true, reason: 'The scope update fixture requires a local direct claim.' })).ok, true);

  const refused = await callToolRaw('update', { project, ref: ticket.ref, files: ['lib/allowed.js', 'foreign/new.js'] });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /refusing active-claim scope change for foreign\/new\.js/i);
  assert.match(refused.content[0].text, /--by <your-id>/i);
  assert.doesNotMatch(refused.content[0].text, new RegExp(`--by ${by}`));
  assert.deepEqual(store.getTicket(project, ticket.ref).files, ['lib/allowed.js']);

  await callTool('update', { project, ref: ticket.ref, by, files: ['lib/allowed.js'] });
  assert.deepEqual(store.getTicket(project, ticket.ref).files, ['lib/allowed.js']);

  await callTool('update', { project, ref: ticket.ref, by: 'mcp-scope-control-plane', files: ['lib/allowed.js', 'foreign/new.js'] });
  assert.deepEqual(store.getTicket(project, ticket.ref).files, ['lib/allowed.js', 'foreign/new.js']);

  const unclaimed = store.createTicket(project, {
    title: 'MCP unclaimed scope update', files: ['lib/allowed.js'], complexity: 3,
    labels: ['direct-ok'], complexityWhy: 'unclaimed tickets remain editable by the control plane',
  });
  await callTool('update', { project, ref: unclaimed.ref, files: ['lib/allowed.js', 'foreign/new.js'] });
  assert.deepEqual(store.getTicket(project, unclaimed.ref).files, ['lib/allowed.js', 'foreign/new.js']);
});

test('MCP update schema exposes control-plane scope approval', () => {
  const update = mcp.toolDescriptors().find((descriptor: any) => descriptor.name === 'update');
  assert.ok(update);
  assert.equal(update.inputSchema.properties.by.type, 'string');
});

test('sweepClaims releases stale claims through MCP', async () => {
  const created = await callTool('add', { title: 'MCP stale sweep', unclassified: true });
  const slug = created.project;
  assert.equal(store.claimTicket(slug, created.ref, 'mcp-stale').ok, true);
  const stale = store.getTicket(slug, created.ref);
  stale.claim.at = new Date(Date.now() - store.claimIdleMs() - 1).toISOString();
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
  assert.deepStrictEqual(Object.keys(d.inputSchema.properties).sort(), ['allowRepeatFailure', 'allowUnscoped', 'full', 'integrationBranch', 'project', 'ref', 'sharedTree']);
  assert.deepStrictEqual(d.inputSchema.required, ['ref']);

  seedCatalog([{ slug: 'codex-gpt-5-6-terra', id: 'claude-gpt-5.6-terra', label: 'Terra' }]);
  store.setCategory({ id: 'dispatch-codex', name: 'Dispatch Codex', route: { model: 'codex-gpt-5-6-terra', effort: 'high' } });
  const slug = store.ensureProject(PROJ).slug;

  const addedInstant = await callTool('add', { title: 'instant dispatch', description: DISPATCH_DESCRIPTION, category: 'dispatch-codex' });
  const instant = await callTool('dispatch', { ref: addedInstant.ref, session: 'mcp-dispatch-session', full: true });
  assert.equal(instant.mode, 'instant');
  assert.deepEqual(instant.exec, {
    agent: 'sidequest-exec-dispatch', model: null, backend: 'codex',
    runsModel: 'codex-gpt-5-6-terra', apiModel: 'claude-gpt-5.6-terra',
    runsLabel: 'Terra', dispatch: 'native-agent',
  });
  assert.equal(instant.agent, 'sidequest-exec-dispatch');
  assert.equal(instant.spawn.description, 'Terra, high · instant dispatch');
  assert.equal(instant.spawn.name, `${addedInstant.ref.toLowerCase()}-instant-dispatch`);
  assert.equal(instant.spawn.model, undefined);
  assert.equal(instant.spawn.subagent_type, instant.agent);
  assert.equal(instant.tokenPrefix, instant.token.slice(0, 12));
  assert.equal(Object.hasOwn(instant, 'briefing'), false);
  assert.ok(Buffer.byteLength(instant.spawn.prompt) < 1200, `dispatch stub is ${Buffer.byteLength(instant.spawn.prompt)} bytes`);
  assert.match(instant.spawn.prompt, /Title: instant dispatch/);
  assert.ok(instant.spawn.prompt.includes(DISPATCH_DESCRIPTION));
  assert.match(instant.spawn.prompt, new RegExp(`briefing ${addedInstant.ref} --token ${instant.token}`));
  assert.match(instant.spawn.prompt, /FIRST action:/);
  assert.match(instant.spawn.prompt, /\[sidequest-route model=gpt-5\.6-terra effort=high\]/);
  assert.doesNotMatch(instant.spawn.prompt, /## This ticket/);
  assert.doesNotMatch(instant.spawn.prompt, /You are a sidequest ticket executor/);
  assert.doesNotMatch(instant.spawn.prompt, /^---$/m);
  const expectedBriefing = agentsync.withProjectIdentity(agentsync.renderTicketBriefing(
    store.getTicket(slug, addedInstant.ref), instant.token, slug, PROJ,
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
    name: `${added.ref.toLowerCase()}-complete-instant-spawn`,
    mode: 'bypassPermissions',
    description: 'Claude Fable, xhigh · complete instant spawn',
    isolation: 'worktree',
    model: 'fable',
  });
  assert.match(prompt, /briefing SQ-/);
  assert.match(prompt, /FIRST action:.*--project/);
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
  seedCatalog([{ slug: 'codex-gpt-5-6-terra', id: 'claude-gpt-5.6-terra', label: 'Terra' }]);
  try {
    store.setCategory({ id: 'native-codex', name: 'Native Codex', route: { model: 'codex-gpt-5-6-terra', effort: 'high' } });
    const added = await callTool('add', {
      title: 'prompt context', category: 'native-codex',
      anchors: 'lib/work.js:14 executorPrompt', verify: 'node --test plugins/sidequest/test/work.test.js',
    });
    const native = await callHandler('native_agent', { ref: added.ref, prompt: 'Implement exactly this ticket.' });
    assert.strictEqual(native.fallback, true);
    assert.strictEqual(native.file, null);
    assert.strictEqual(native.spawn.subagent_type, 'sidequest-exec-dispatch');
    assert.strictEqual(native.spawn.description, 'Terra, high · prompt context');
    assert.strictEqual(native.spawn.name, `${added.ref.toLowerCase()}-prompt-context`);
    assert.strictEqual(native.spawn.model, undefined);
    assert.match(native.prompt, /Authoritative ticket contract \(the task prompt may add logistics only; do not narrow this scope\):/);
    assert.match(native.prompt, /Title: prompt context/);
    assert.match(native.prompt, /Anchors:\nlib\/work\.js:14 executorPrompt/);
    assert.match(native.prompt, /Verify command:\nnode --test plugins\/sidequest\/test\/work\.test\.js/);
  } finally {
    clearCatalog();
  }
});

test('native_agent applies explicit ticket route override refusals before spawning', async () => {
  seedCatalog([
    { slug: 'codex-gpt-5-6-terra', id: 'claude-gpt-5.6-terra', label: 'Terra' },
    { slug: 'codex-gpt-5-6-sol', id: 'claude-gpt-5.6-sol', label: 'Sol' },
  ]);
  try {
    const slug = store.ensureProject(PROJ).slug;
    store.setCategory({ id: 'native-route-override-codex', name: 'Native route override Codex', route: { model: 'codex-gpt-5-6-terra', effort: 'high' } });
    store.setCategory({ id: 'native-route-override-claude', name: 'Native route override Claude', route: { model: 'sonnet', effort: 'high' } });
    const crossing = store.createTicket(slug, {
      title: 'Refuse provider crossing through MCP native agent',
      category: 'native-route-override-claude',
      route: { model: 'codex-gpt-5-6-sol', effort: 'high' },
    });
    const sameProvider = store.createTicket(slug, {
      title: 'Allow same provider through MCP native agent',
      category: 'native-route-override-codex',
      route: { model: 'codex-gpt-5-6-sol', effort: 'high' },
    });

    await assert.rejects(
      () => callHandler('native_agent', { ref: crossing.ref, prompt: 'Implement the ticket.' }),
      /route override "codex-gpt-5-6-sol" crosses providers from category "native-route-override-claude" and was refused/,
    );

    const native = await callHandler('native_agent', { ref: sameProvider.ref, prompt: 'Implement the ticket.' });
    assert.equal(native.effort, 'high');
    assert.equal(native.spawn.subagent_type, 'sidequest-exec-dispatch');
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
    name: added.ref.toLowerCase() + '-complete-native-spawn',
    mode: 'bypassPermissions',
    description: 'Claude Fable, xhigh · complete native spawn',
    isolation: 'worktree',
    model: 'fable',
    prompt: native.prompt,
  });
  assert.equal(native.effort, 'xhigh');
  assert.equal(native.projectPath, PROJ);
  assert.match(native.spawn.prompt, new RegExp(`--project "${PROJ.replace(/\\/g, '\\\\')}"`));
});

test('native_agent isolates declared-file tickets unless shared-tree is requested', async () => {
  seedCatalog([{ slug: 'codex-gpt-5-6-terra', id: 'claude-gpt-5.6-terra', label: 'Terra' }]);
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
  // Complexity 3 and no declared files trips the no-declared-scope warning, so
  // "compact" still carries a warnings key here.
  assert.deepStrictEqual(Object.keys(out).sort(), ['ok', 'project', 'ref', 'status', 'warnings']);
  assert.match(out.ref, /^SQ-\d+$/);
  assert.strictEqual(out.status, 'todo');
});

test('MCP add warns when declared output is outside the repo worktree', async () => {
  const outside = path.join(os.tmpdir(), `sq-mcp-add-audition-${process.pid}.html`);
  fs.writeFileSync(outside, '<main>audition</main>\n');
  const scope = outside.replace(/\\/g, '/');
  const added = await callTool('add', {
    title: 'MCP external output warning',
    files: [scope],
    complexity: 3,
    why: 'confirm planning guidance appears before an external-output executor dispatch',
  });

  assert.deepEqual(added.warnings, [
    `Planning-depth warning: declared paths are outside the repo worktree: ${scope}. A repo-changing category can't commit them. Use an artifact/non-repo category, or declare in-repo paths.`,
  ]);
});

test('MCP add warns when coding.hard already prescribes a fix', async () => {
  await callTool('category_list', {});
  const added = await callTool('add', {
    title: 'MCP prescriptive hard change',
    category: 'coding.hard',
    description: 'FIX: replace the legacy parser with the shared parser.',
  });
  assert.deepStrictEqual(added.warnings, [
    'coding.hard is for unknown approaches; this description already spells out the fix, which usually means coding.normal. Recheck the category.',
    NO_SCOPE_WARNING,
  ]);
});

test('category stamps stay quiet across MCP server restarts', async () => {
  const session = freshMcpServer();
  const slug = store.ensureProject(PROJ).slug;
  const existing = store.createTicket(slug, { title: 'update without category', category: 'coding.easy' });
  const unchangedCategory = await callToolOn(session, 'update', { ref: existing.ref, title: 'update without a category stamp' });
  assert.deepEqual(unchangedCategory.warnings, [NO_SCOPE_WARNING]);

  await callToolOn(session, 'category_list', {});
  const acknowledged = await callToolOn(session, 'add', { title: 'category stamped after read', category: 'coding.easy' });
  assert.deepEqual(acknowledged.warnings, [NO_SCOPE_WARNING]);

  const restarted = freshMcpServer();
  const afterRestart = await callToolOn(restarted, 'add', { title: 'category stamped after restart', category: 'coding.easy' });
  assert.deepEqual(afterRestart.warnings, [NO_SCOPE_WARNING]);

  await callTool('category_list', {});
});

test('dispatch rejects a thin routed brief but only warns about a missing coding verify command', async () => {
  const added = await callTool('add', { title: 'thin dispatch fixture', category: 'debugging' });
  assert.equal(added.ok, true);
  const refused = await callToolRaw('dispatch', { ref: added.ref });
  assert.ok(refused.isError);
  assert.match(refused.content[0].text, /executor's entire brief is this ticket/);

  await callTool('update', { ref: added.ref, description: DISPATCH_DESCRIPTION });
  const dispatched = await callTool('dispatch', { ref: added.ref, full: true, allowUnscoped: true });
  assert.deepStrictEqual(dispatched.warnings, [
    `Dispatch warning: ${NO_SCOPE_WARNING.replace('Planning-depth warning: ', '')}`,
    'Dispatch warning: this coding/debugging ticket has no verify command. Add one before the executor starts.',
  ]);

  seedCatalog([{ id: 'claude-gpt-5.6-luna', slug: 'codex-gpt-5-6-luna', label: 'GPT-5.6 Luna' }]);
  const research = await callTool('add', { title: 'research dispatch fixture', description: DISPATCH_DESCRIPTION, category: 'source-lookup' });
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
  // Still no declared files on this ticket, so the no-declared-scope warning rides along.
  assert.deepStrictEqual(Object.keys(updated).sort(), ['ok', 'project', 'ref', 'status', 'warnings']);
  assert.equal(store.getTicket(added.project, added.ref).categoryId, 'mcp-update-echo');
});

test('add and update warn only for unknown ticket refs introduced by the operation', async () => {
  const known = await callTool('add', { title: 'known ticket', unclassified: true });
  const added = await callTool('add', { title: `use ${known.ref} and SQ-9999`, unclassified: true });
  assert.deepStrictEqual(added.warnings, ['Unknown ticket refs: SQ-9999.', NO_SCOPE_WARNING]);

  const updated = await callTool('update', { ref: added.ref, description: 'now use SQ-9998' });
  assert.deepStrictEqual(updated.warnings, ['Unknown ticket refs: SQ-9998.', NO_SCOPE_WARNING]);

  fs.mkdirSync(path.join(PROJ, 'src'), { recursive: true });
  const filesOnly = await callTool('update', { ref: added.ref, files: ['src/changed.ts'] });
  assert.deepStrictEqual(filesOnly.warnings, ['Planning-depth warning: declared file scope does not exist in the repo: src/changed.ts.']);
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
  staleCliTicket.claim.at = new Date(Date.now() - store.claimIdleMs() - 1).toISOString();
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
  staleMcpTicket.claim.at = new Date(Date.now() - store.claimIdleMs() - 1).toISOString();
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

  const done = await callTool('done', { ref, by: 'mcp-worker-1', model: ticket.model, effort: ticket.effort, body: 'MCP completion evidence' });
  assert.deepStrictEqual(Object.keys(done).sort(), ['ok', 'project', 'ref', 'status']);
  assert.strictEqual(done.status, 'done');
});

test('MCP done requires a final report and release records its reason', async () => {
  const added = await callTool('add', { title: 'required final report', complexity: 2, why: 'exercise final-report validation and durable release reasons', labels: ['direct-ok'] });
  const ticket = store.getTicket(added.project, added.ref);
  await callTool('claim', { ref: added.ref, by: 'mcp-report-worker', direct: true, reason: 'The required-report fixture needs a direct claim.' });

  const missing = await callToolRaw('done', { ref: added.ref, by: 'mcp-report-worker', model: ticket.model, effort: ticket.effort });
  assert.ok(missing.isError, 'done refuses a missing final report');
  assert.match(missing.content[0].text, /"body" is required.*completion comment.*full final report/i);
  const blank = await callToolRaw('done', { ref: added.ref, by: 'mcp-report-worker', model: ticket.model, effort: ticket.effort, body: ' \n\t ' });
  assert.ok(blank.isError, 'done refuses a blank final report');
  assert.match(blank.content[0].text, /"body" is required.*full final report/i);
  assert.ok(store.getTicket(added.project, added.ref).claim, 'report validation keeps the claim');

  await callTool('done', { ref: added.ref, by: 'mcp-report-worker', model: ticket.model, effort: ticket.effort, body: 'Changed mcp.ts; tests passed.' });
  const completed = store.getTicket(added.project, added.ref);
  assert.ok(completed.completion.commentId, 'done stores the completion comment id');
  assert.equal(completed.comments.at(-1).body, 'Changed mcp.ts; tests passed.');

  const released = await callTool('add', { title: 'required release reason', complexity: 2, why: 'exercise durable release-reason validation', labels: ['direct-ok'] });
  await callTool('claim', { ref: released.ref, by: 'mcp-release-worker', direct: true, reason: 'The release-reason fixture needs a direct claim.' });
  const missingReason = await callToolRaw('release', { ref: released.ref, by: 'mcp-release-worker' });
  assert.ok(missingReason.isError, 'release refuses a missing reason');
  assert.match(missingReason.content[0].text, /"reason" is required.*why.*released/i);
  const unclassified = await callTool('release', { ref: released.ref, by: 'mcp-release-worker', reason: 'Scope path was refused.', status: 'todo' });
  assert.equal(unclassified.ok, false, 'release refuses an unclassified reasoned handback');
  assert.equal(unclassified.reason, 'release_kind_required');
  await callTool('release', { ref: released.ref, by: 'mcp-release-worker', reason: 'Scope path was refused.', kind: 'handback', status: 'todo' });
  const afterRelease = store.getTicket(released.project, released.ref);
  assert.equal(afterRelease.claim, null);
  assert.deepEqual(afterRelease.release, {
    kind: 'handback',
    reason: 'Scope path was refused.',
    evidence: null,
    source: 'mcp',
    at: afterRelease.release.at,
  });
  assert.equal(afterRelease.comments.at(-1).body, 'Released: Scope path was refused.');
  assert.equal(afterRelease.comments.at(-1).by, 'mcp-release-worker');
});

test('MCP release records technical-blocker evidence and refuses incomplete evidence', async () => {
  const added = await callTool('add', { title: 'technical blocker evidence', complexity: 2, why: 'exercise evidence required for command-failure handoffs', labels: ['direct-ok'] });
  await callTool('claim', { ref: added.ref, by: 'mcp-technical-blocker-worker', direct: true, reason: 'The technical blocker fixture needs a direct claim.' });

  const incomplete = await callTool('release', {
    ref: added.ref,
    by: 'mcp-technical-blocker-worker',
    reason: 'The targeted test failed.',
    kind: 'technical_blocker',
    command: 'npm run test:files -- test/mcp.test.ts',
    exitCode: 1,
    status: 'todo',
  });
  assert.equal(incomplete.ok, false, 'technical blockers require an output tail');
  assert.equal(incomplete.reason, 'technical_blocker_evidence_required');
  assert.ok(store.getTicket(added.project, added.ref).claim, 'evidence refusal keeps the claim');

  await callTool('release', {
    ref: added.ref,
    by: 'mcp-technical-blocker-worker',
    reason: 'The targeted test failed.',
    kind: 'technical_blocker',
    command: 'npm run test:files -- test/mcp.test.ts',
    exitCode: 1,
    outputTail: 'not ok 1 - technical blocker fixture',
    status: 'todo',
  });
  const released = store.getTicket(added.project, added.ref);
  assert.equal(released.release.kind, 'technical_blocker');
  assert.deepEqual(released.release.evidence, {
    kind: 'technical_blocker',
    command: 'npm run test:files -- test/mcp.test.ts',
    exitCode: 1,
    outputTail: 'not ok 1 - technical blocker fixture',
  });
  assert.match(released.comments.at(-1).body, /Command: npm run test:files -- test\/mcp\.test\.ts/);
  assert.match(released.comments.at(-1).body, /Exit code: 1/);
  assert.match(released.comments.at(-1).body, /not ok 1 - technical blocker fixture/);
});

test('MCP release records contradiction probe evidence and accepts a zero exit code', async () => {
  const added = await callTool('add', { title: 'contradiction evidence', complexity: 2, why: 'exercise probe evidence required for contradiction handoffs', labels: ['direct-ok'] });
  await callTool('claim', { ref: added.ref, by: 'mcp-contradiction-worker', direct: true, reason: 'The contradiction fixture needs a direct claim.' });

  const incomplete = await callTool('release', {
    ref: added.ref,
    by: 'mcp-contradiction-worker',
    reason: 'The named target is absent.',
    kind: 'contradiction',
    command: 'rg -n "named target" plugins/sidequest/src',
    status: 'todo',
  });
  assert.equal(incomplete.ok, false, 'contradictions require actual probe output');
  assert.equal(incomplete.reason, 'contradiction_evidence_required');
  assert.ok(store.getTicket(added.project, added.ref).claim, 'evidence refusal keeps the claim');

  await callTool('release', {
    ref: added.ref,
    by: 'mcp-contradiction-worker',
    reason: 'The named target is absent.',
    kind: 'contradiction',
    command: 'rg -n "named target" plugins/sidequest/src',
    exitCode: 0,
    outputTail: 'no matches',
    status: 'todo',
  });
  const released = store.getTicket(added.project, added.ref);
  assert.match(released.comments.at(-1).body, /Contradiction evidence/);
  assert.match(released.comments.at(-1).body, /Command: rg -n "named target" plugins\/sidequest\/src/);
  assert.match(released.comments.at(-1).body, /Exit code: 0/);
  assert.match(released.comments.at(-1).body, /no matches/);
});

test('MCP release records an oracle handoff without a separate reason', async () => {
  seedCatalog([{ id: 'claude-gpt-5.6-terra', slug: 'codex-gpt-5-6-terra', label: 'GPT-5.6 Terra' }]);
  const added = await callTool('add', { title: 'oracle release fixture', complexity: 2, why: 'exercise the human verdict handoff through the MCP release surface' });
  const prepared = store.prepareDispatch(added.project, added.ref, { sessionId: `oracle-release-${Date.now()}` });
  assert.equal(store.claimTicket(added.project, added.ref, 'mcp-oracle-worker', {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);

  await callTool('release', {
    project: added.project,
    ref: added.ref,
    by: 'mcp-oracle-worker',
    status: 'doing',
    oracle: 'Rank the two rendered candidates without reading the measurements.',
    candidate: 'abc1234',
    deliverable: 'artifacts/comparison.wav',
  });

  const ticket = store.getTicket(added.project, added.ref);
  assert.deepEqual(ticket.oracle, {
    round: 1,
    at: ticket.oracle.at,
    candidate: 'abc1234',
    deliverable: 'artifacts/comparison.wav',
    ask: 'Rank the two rendered candidates without reading the measurements.',
  });
  assert.equal(ticket.claim, null);
  assert.equal(ticket.comments.at(-1).body, 'Released: Rank the two rendered candidates without reading the measurements.');
  const pulse = await callTool('pulse', { project: added.project, ref: added.ref });
  assert.equal(pulse.oracle.summary, `awaiting oracle since ${ticket.oracle.at}, round 1, candidate abc1234, ask: Rank the two rendered candidates without reading the measurements.`);
});

test('MCP verdict creates a missing oracle round and refuses a ticket with no oracle marker', async () => {
  const added = await callTool('add', { title: 'oracle verdict fixture', complexity: 2, why: 'exercise the verdict operation through MCP' });
  const prepared = store.prepareDispatch(added.project, added.ref, { sessionId: `mcp-verdict-${Date.now()}` });
  assert.equal(store.claimTicket(added.project, added.ref, 'mcp-verdict-worker', {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);
  assert.equal(store.releaseTicket(added.project, added.ref, 'mcp-verdict-worker', {
    status: 'doing',
    oracle: 'Rank the candidates.',
    candidate: 'abc1234',
  }).ok, true);

  const verdict = await callTool('verdict', {
    project: added.project,
    ref: added.ref,
    text: 'Candidate B wins.',
    outcome: 'accepted',
    why: 'The transient is less sharp.',
    constraint: 'Keep the transient below the reference.',
  });
  assert.equal(verdict.ok, true);
  assert.equal(store.getTicket(added.project, added.ref).oracle, null);
  const experiment = store.experimentPacket(added.project, added.ref);
  const log = fs.readFileSync(store.assetPath(added.project, store.getTicket(added.project, added.ref).id, experiment.asset), 'utf8');
  assert.match(log, /Verdict: "Candidate B wins\." — accepted/);
  assert.match(log, /Status: accepted abc1234/);
  assert.match(log, /\[R1\] Keep the transient below the reference\./);

  const refused = await callTool('verdict', {
    project: added.project,
    ref: added.ref,
    text: 'Candidate B wins.',
    outcome: 'accepted',
  });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /not awaiting an oracle verdict/i);
});

test('MCP comments default to the active claim holder', async () => {
  const project = store.ensureProject(path.join(os.tmpdir(), 'sq-mcp-comment-claim-holder')).slug;
  const ticket = store.createTicket(project, {
    title: 'comment claim holder fixture', complexity: 1,
    complexityWhy: 'prove an omitted MCP comment author remains eligible for the claimant verification gates',
  });
  const by = 'mcp-comment-claim-holder';
  assert.equal((await callTool('claim', {
    project, ref: ticket.ref, by, direct: true,
    reason: 'The comment attribution fixture requires a local direct claim.',
  })).ok, true);

  assert.equal((await callTool('comment', {
    project,
    ref: ticket.ref,
    body: '[sidequest:negative-control] npm run test:files test/fixture.test.js failed=1',
  })).ok, true);

  assert.equal(store.getTicket(project, ticket.ref).comments.at(-1).by, by);
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

test('SQ-1015: plan writes replace-whole-document, past the 16K comment cap, and reject oversized bodies', async () => {
  const added = await callTool('add', { title: 'plan document fixture', complexity: 1, why: 'exercise the plan MCP verb round trip' });
  const ref = added.ref;

  const first = `# Plan\n\n${'x'.repeat(60_000)}`;
  const written = await callTool('plan', { ref, body: first, by: 'planner-1' });
  assert.strictEqual(written.ok, true);
  assert.strictEqual(written.revision, 1);
  assert.ok(written.path, 'the write ack names the stored path');
  assert.strictEqual(fs.readFileSync(written.path, 'utf8'), first, 'the plan asset holds the full body, unbounded by the comment cap');

  const second = '# Replaced plan\n\nEntirely different content.';
  const replaced = await callTool('plan', { ref, body: second, by: 'planner-2' });
  assert.strictEqual(replaced.ok, true);
  assert.strictEqual(replaced.revision, 2, 'a rewrite bumps the revision rather than appending');
  assert.strictEqual(fs.readFileSync(replaced.path, 'utf8'), second, 'the document is replaced whole, not appended to');
  assert.strictEqual(replaced.path, written.path, 'the plan lives at one stable path across revisions');

  const tooLong = 'x'.repeat(256 * 1024 + 1);
  const rejected = await callTool('plan', { ref, body: tooLong });
  assert.strictEqual(rejected.ok, false);
  assert.strictEqual(rejected.reason, 'too_long');
  assert.strictEqual(rejected.max, 256 * 1024);
  assert.strictEqual(rejected.length, 256 * 1024 + 1);
  assert.strictEqual(fs.readFileSync(replaced.path, 'utf8'), second, 'a rejected oversized write leaves the prior revision untouched');

  const empty = await callTool('plan', { ref, body: '   ' });
  assert.strictEqual(empty.ok, false);
  assert.strictEqual(empty.reason, 'empty');
});

test('claim requires a worker id (no shared-identity default)', async () => {
  const added = await callTool('add', { title: 'needs by', complexity: 2, why: 'confirm the atomic-claim identity guard is enforced over MCP' });
  const res = await callToolRaw('claim', { ref: added.ref });
  assert.ok(res.isError, 'a claim without by is refused');
  assert.match(res.content[0].text, /by.*required/i);
});

test('MCP dispatch returns the Codex readiness recovery text without preparing state', async () => {
  const message = 'Codex dispatch refused: claude-code-proxy is not answering on /v1/models. Run `node "gateway" ensure`, then retry. No Anthropic fallback was used.';
  seedCatalog([{ id: 'claude-gpt-5.6-terra', slug: 'codex-gpt-5-6-terra', label: 'GPT-5.6 Terra' }], {
    ready: false,
    state: 'proxy-down',
    message,
  });
  try {
    store.setCategory({ id: 'mcp-readiness-refusal', name: 'MCP readiness refusal', route: { model: 'codex-gpt-5-6-terra', effort: 'high' } });
    const added = await callTool('add', { title: 'readiness refusal', description: DISPATCH_DESCRIPTION, category: 'mcp-readiness-refusal' });
    const refused = await callToolRaw('dispatch', { ref: added.ref });
    assert.ok(refused.isError);
    assert.equal(refused.content[0].text, message);
    const ticket = store.getTicket(added.project, added.ref);
    assert.equal(ticket.dispatchNonce, null);
    assert.equal(ticket.dispatch, null);
  } finally {
    seedCatalog([
      { id: 'claude-gpt-5.6-terra', slug: 'codex-gpt-5-6-terra', label: 'GPT-5.6 Terra' },
      { id: 'claude-gpt-5.6-luna', slug: 'codex-gpt-5-6-luna', label: 'GPT-5.6 Luna' },
    ]);
  }
});

test('MCP dispatch refuses external providers without a ready schema-4 entry', async () => {
  const grok = { id: 'claude-grok-test', slug: 'grok-test', label: 'Grok Test', provider: 'grok' };
  const fixtures = [
    { id: 'missing-provider', providers: { codex: { ready: true, state: 'ready', message: 'Codex is ready.' } }, expected: /provider grok is unavailable/ },
    { id: 'missing-readiness', providers: { grok: {} }, expected: /provider grok is unavailable/ },
    { id: 'not-ready', providers: { grok: { ready: false, state: 'signed-out', message: 'Sign in to Grok CLI.' } }, expected: /grok dispatch refused: Sign in to Grok CLI\./ },
  ];
  try {
    for (const fixture of fixtures) {
      seedCatalogV4([grok], fixture.providers);
      store.setCategory({ id: `mcp-grok-${fixture.id}`, name: `MCP Grok ${fixture.id}`, route: { model: grok.slug, effort: 'high' } });
      const added = await callTool('add', { title: `grok ${fixture.id}`, description: DISPATCH_DESCRIPTION, category: `mcp-grok-${fixture.id}` });
      const refused = await callToolRaw('dispatch', { ref: added.ref });
      assert.ok(refused.isError);
      assert.match(refused.content[0].text, fixture.expected);
      assert.match(refused.content[0].text, /No Anthropic fallback was used\./);
      const ticket = store.getTicket(added.project, added.ref);
      assert.equal(ticket.dispatchNonce, null);
      assert.equal(ticket.dispatch, null);
    }
  } finally {
    seedCatalog([
      { id: 'claude-gpt-5.6-terra', slug: 'codex-gpt-5-6-terra', label: 'GPT-5.6 Terra' },
      { id: 'claude-gpt-5.6-luna', slug: 'codex-gpt-5-6-luna', label: 'GPT-5.6 Luna' },
    ]);
  }
});

test('MCP claim binds an unlaunched isolated dispatch with its prepared token', async () => {
  seedCatalog([{ id: 'claude-gpt-5.6-terra[1m]', slug: 'codex-gpt-5-6-terra', label: 'GPT-5.6 Terra' }]);
  store.setCategory({ id: 'mcp-dispatch-claim', name: 'MCP dispatch claim', route: { model: 'codex-gpt-5-6-terra', effort: 'high' } });
  const added = await callTool('add', { title: 'nonce through MCP', category: 'mcp-dispatch-claim' });
  const slug = store.ensureProject(PROJ).slug;
  const prepared = store.prepareDispatch(slug, added.ref, { sessionId: 'mcp-launch-session', sharedTree: false });
  const refused = await callTool('claim', { ref: added.ref, by: 'mcp-no-token' });
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.reason, 'token');

  const accepted = await callTool('claim', {
    ref: added.ref,
    by: 'mcp-token-bound-agent',
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  });
  assert.strictEqual(accepted.ok, true);
  const dispatch = store.getTicket(slug, added.ref).dispatch;
  assert.equal(dispatch.bindSource, 'claim_token');
  assert.equal(dispatch.sessionId, MCP_SESSION_ID);
  assert.ok(dispatch.boundAt);
});

test('MCP blocks no-dispatch routed claims and records an explicit direct research bypass', async () => {
  const added = await callTool('add', { title: 'no-file research', category: 'coding.easy' });
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

test('MCP direct-claim refusal requires a reason and prints the prepared executor call', async () => {
  const added = await callTool('add', { title: 'direct reason required', category: 'coding.easy' });
  const refused = await callTool('claim', { ref: added.ref, by: 'mcp-direct-refusal', direct: true });
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.reason, 'direct_reason_required');
  assert.match(refused.message, /recorded direct rationale/);
  assert.match(refused.message, /inline-safe/);
});

test('MCP direct claim refuses rationalizations outside the inline-safe allowlist', async () => {
  const added = await callTool('add', { title: 'invalid direct rationale', category: 'coding.easy' });
  const refused = await callTool('claim', {
    ref: added.ref,
    by: 'mcp-invalid-direct-reason',
    direct: true,
    reason: 'The context already loaded makes this a faster myself small change.',
  });
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.reason, 'direct_not_allowed');
  assert.match(refused.message, /inline-safe allowlist/);
  assert.match(refused.message, /new behavior\/API/);
  assert.match(refused.message, /failing test that does not pinpoint/);
});

test('MCP claim rejects a generic executor for a Codex route', async () => {
  seedCatalog([{ id: 'claude-gpt-5.6-terra[1m]', slug: 'codex-gpt-5-6-terra', label: 'GPT-5.6 Terra' }]);
  try {
    store.setCategory({ id: 'claim-codex', name: 'Claim Codex', route: { model: 'codex-gpt-5-6-terra', effort: 'high' } });
    const added = await callTool('add', { title: 'Codex executor guard', category: 'claim-codex' });
    const ticket = store.getTicket(store.ensureProject(PROJ).slug, added.ref);
    const prepared = store.prepareDispatch(store.ensureProject(PROJ).slug, added.ref);
    const rejected = await callTool('claim', { ref: added.ref, by: 'mcp-generic', effort: ticket.effort, executor: `sidequest-exec-${ticket.effort}`, token: prepared.token });
    assert.strictEqual(rejected.ok, false);
    assert.strictEqual(rejected.reason, 'executor_mismatch');
    assert.strictEqual(rejected.expectedExecutor, prepared.ticket.dispatchExecutor);
    assert.ok(rejected.message.includes('Expected executor: `' + prepared.ticket.dispatchExecutor + '`'));
    assert.ok(rejected.message.includes(`executor: ${JSON.stringify(prepared.ticket.dispatchExecutor)}`));
    assert.ok(rejected.message.includes(`token: ${JSON.stringify(prepared.token)}`));
    assert.ok(rejected.message.includes(`project: ${JSON.stringify(PROJ)}`));
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
  assert.equal(Object.hasOwn(t, 'claim'), false);
});

test('MCP board reads omit taxonomy and default ready rows stay summary-sized', async () => {
  const added = await callTool('add', { title: 'trimmed taxonomy response', category: 'coding.easy' });
  const list = await callTool('list', {});
  const ready = await callTool('ready', {});
  const changes = await callTool('changes', {});
  const pulse = await callTool('pulse', { ref: added.ref });

  assert.equal(list.categories, undefined);
  assert.equal(ready.categories, undefined);
  assert.equal(changes.categories, undefined);
  assert.equal(pulse.categories, undefined);
  assert.equal(typeof list.claimIdleMs, 'number');
  assert.equal(ready.claimIdleMs, undefined);
  assert.equal(list.tickets.find((ticket: any) => ticket.ref === added.ref).categoryId, 'coding.easy');
  assert.deepEqual(ready.tickets.find((ticket: any) => ticket.ref === added.ref), { ref: added.ref, title: 'trimmed taxonomy response' });
  assert.equal(ready.count, ready.tickets.length);
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
  tool.handler = (args: any) => new Promise((resolve) => releases.push(() => resolve({ marker: args.ref })));
  try {
    const first = mcp.handleRequest({ jsonrpc: '2.0', id: 9101, method: 'tools/call', params: { name: 'list', arguments: { ref: 'first' } } });
    const second = mcp.handleRequest({ jsonrpc: '2.0', id: 9102, method: 'tools/call', params: { name: 'list', arguments: { ref: 'second' } } });
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
    started.push(args.ref);
    releases.set(args.ref, () => resolve({ marker: args.ref }));
  });
  const first = mcp.handleRequest({ jsonrpc: '2.0', id: 9201, method: 'tools/call', params: { name: 'comment', arguments: { project: PROJ, ref: 'first' } } });
  const second = mcp.handleRequest({ jsonrpc: '2.0', id: 9202, method: 'tools/call', params: { name: 'comment', arguments: { project: PROJ, ref: 'second' } } });
  const otherProject = store.ensureProject(path.join(FIXTURE_ROOT, 'other-board')).slug;
  const other = mcp.handleRequest({ jsonrpc: '2.0', id: 9203, method: 'tools/call', params: { name: 'comment', arguments: { project: otherProject, ref: 'other' } } });
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
  seedCatalog([{ slug: 'codex-terra', id: 'claude-gpt-5.6-terra[1m]', label: 'Codex Terra' }]);
  try {
    store.setCategory({ id: 'model-codex', name: 'Model Codex', route: { model: 'codex-terra', effort: 'high' }, fallback: { model: 'opus', effort: 'high' } });
    const out = await callHandler('models', {});
    assert.ok(out.models.includes('codex-terra'));
    assert.ok(out.categories.some((category: any) => category.id === 'model-codex' && category.route === 'codex-terra·high'));
    const full = await callHandler('models', { full: true });
    assert.ok(full.categories.some((category: any) => category.id === 'model-codex' && category.resolved.model === 'codex-terra'));
    assert.ok(!JSON.stringify(out).includes('grade-'));
  } finally {
    clearCatalog();
  }
});

test('route_recipe resolves a live route and makes category errors explicit', async () => {
  seedCatalog([{ slug: 'codex-terra', id: 'claude-gpt-5.6-terra[1m]', label: 'Codex Terra' }]);
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
  seedCatalog([{ slug: 'codex-terra', id: 'claude-gpt-5.6-terra[1m]' }]);
  try {
    store.setCategory({ id: 'provenance-codex', name: 'Provenance Codex', route: { model: 'codex-terra', effort: 'high' } });
    const added = await callTool('add', { title: 'codex provenance', category: 'provenance-codex' });
    const ref = added.ref;
    await callTool('claim', { ref, by: 'mcp-w-codex' });
    const done = await callTool('done', { ref, by: 'mcp-w-codex', model: 'codex-terra', effort: 'high', body: 'Codex completion evidence' });
    assert.strictEqual(done.ok, true);
    assert.strictEqual(store.getTicket(added.project, ref).workedBy.model, 'codex-terra');
  } finally {
    clearCatalog();
  }
});

test('reporting aliases resolve to catalog slugs and dispatched done defaults provenance', async () => {
  seedCatalog([
    { slug: 'codex-gpt-5-6-terra-fast', id: 'claude-gpt-5.6-terra-fast[1m]' },
    { slug: 'codex-gpt-5-6-luna-fast', id: 'claude-gpt-5.6-luna-fast[1m]' },
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
      await callTool('done', { ref: added.ref, by, body: 'Alias completion evidence', ...(model == null ? {} : { model, effort: 'high' }) });
      return store.getTicket(added.project, added.ref);
    };

    for (const alias of ['gpt-5.6-terra-fast', 'claude-gpt-5.6-terra-fast[1m]', 'CLAUDE-CODEX-GPT-5.6-TERRA-FAST']) {
      const ticket = await complete(`alias ${alias}`, alias);
      assert.equal(ticket.workedBy.model, 'codex-gpt-5-6-terra-fast');
    }
    assert.equal(store.classifyModelFilter('gpt-5.6-terra-fast'), 'codex-gpt-5-6-terra-fast');
    assert.equal(store.classifyModelFilter('claude-gpt-5.6-terra-fast'), 'codex-gpt-5-6-terra-fast');
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
    const unknown = await callToolRaw('done', { ref: added.ref, by: 'mcp-alias-unknown', model: 'claude-codex-auto', body: 'Unknown-model completion evidence' });
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
  seedCatalog([{ slug: 'codex-terra', id: 'claude-gpt-5.6-terra[1m]' }]);
  try {
    store.setCategory({ id: 'guard-codex', name: 'Guard Codex', route: { model: 'codex-terra', effort: 'high' } });
    const added = await callTool('add', { title: 'codex guard', category: 'guard-codex' });
    const wrong = store.VALID_EFFORTS.find((effort: any) => effort !== store.getTicket(added.project, added.ref).effort);
    const res = await callTool('claim', { ref: added.ref, by: 'mcp-w-guard', effort: wrong });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'effort_mismatch');
    assert.match(res.message, /spawn sidequest-exec-dispatch./);
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
  assert.ok(allChars < 100000, `compact all:true stays under the result ceiling (${allChars} chars)`);

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

// SQ-923. Whether a run writes anything is an OUTCOME, so no dispatch-time flag
// predicts it: a read-only contract routed through a write-capable category
// records readonly:false correctly and then has nothing to hand in. 27 tickets
// in three days died on that (the:SQ-48/49/54/178, bmr:SQ-95, eige:SQ-820),
// each burning a release plus a re-dispatch. done now goes and looks.
function isolatedDispatch(prefix: string, agentId: string, files: string[]) {
  const repo = fs.realpathSync(committedRepo(prefix));
  const project = store.ensureProject(repo, `SQ-923 ${agentId}`).slug;
  const ticket = store.createTicket(project, {
    title: `read-only outcome ${agentId}`,
    description: 'A write-routed dispatch whose contract forbids repository edits, exactly like the audited bounces.',
    category: 'debugging',
    files,
  });
  const sessionId = `sq923-session-${agentId}`;
  const prepared = store.prepareDispatch(project, ticket.ref, { sessionId });
  assert.equal(prepared.ticket.dispatch.sharedTree, false, 'the fixture dispatch is isolated');
  assert.equal(store.recordDispatchLaunch(project, ticket.ref, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    sessionId,
    agentName: agentId,
  }).ok, true);
  assert.equal(store.bindDispatchAgent(sessionId, prepared.ticket.dispatchExecutor, agentId, agentId).ok, true);
  const worktree = path.join(repo, '.claude', 'worktrees', `agent-${agentId}`);
  gitAt(repo, ['worktree', 'add', '-q', '-b', `agent-${agentId}`, worktree, 'HEAD']);
  assert.equal(store.claimTicket(project, ticket.ref, `by-${agentId}`, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);
  return { repo, project, ref: ticket.ref, by: `by-${agentId}`, worktree };
}

function recordNoOpVerification(fixture: any) {
  assert.equal(store.addComment(fixture.project, fixture.ref, {
    by: fixture.by,
    source: 'mcp',
    body: '[sidequest:verify-start] npm run test:full',
  }).ok, true);
  assert.equal(store.addComment(fixture.project, fixture.ref, {
    by: fixture.by,
    source: 'mcp',
    body: '[sidequest:verify-complete] no-op',
  }).ok, true);
}

test('SQ-1339: done closes a verified no-op write dispatch only after its explicit verification evidence', async () => {
  const fixture = isolatedDispatch('sq-mcp-noop-', 'a923noop', ['src/engine.js']);
  const baseCommit = store.getTicket(fixture.project, fixture.ref).dispatch.baseCommit;
  assert.equal(baseCommit, gitAt(fixture.repo, ['rev-parse', 'HEAD']), 'the dispatch records where the run started');
  assert.equal(store.completeTicket(fixture.project, fixture.ref, fixture.by, {}).reason, 'submission_required');

  const missingEvidence = await callTool('done', {
    project: fixture.project,
    ref: fixture.ref,
    by: fixture.by,
    model: 'opus',
    effort: 'high',
    body: 'Read-only investigation complete; findings are in the thread and the repository is untouched.',
  });
  assert.equal(missingEvidence.ok, false);
  assert.match(missingEvidence.message, /verify-complete\] no-op/);

  recordNoOpVerification(fixture);
  const closed = await callTool('done', {
    project: fixture.project,
    ref: fixture.ref,
    by: fixture.by,
    model: 'opus',
    effort: 'high',
    body: 'Read-only investigation complete; findings are in the thread and the repository is untouched.',
  });
  assert.equal(closed.ok, true, `done was refused: ${closed.message}`);
  const done = store.getTicket(fixture.project, fixture.ref);
  assert.equal(done.status, 'done');
  assert.equal(done.completion.closeout, 'no-repo-changes', 'the closeout records how it was proven');
  assert.equal(done.completion.worktree, fixture.worktree);
});

test('SQ-1339: submit records and integrates an explicit no-op range', async () => {
  const fixture = isolatedDispatch('sq-mcp-submit-noop-', 'a1339noop', ['src/engine.js']);
  const commit = gitAt(fixture.worktree, ['rev-parse', 'HEAD']);
  const gitRef = `refs/sidequest/${fixture.ref}`;
  gitAt(fixture.worktree, ['update-ref', gitRef, commit]);
  recordNoOpVerification(fixture);

  const submitted = await callTool('submit', {
    project: fixture.project,
    ref: fixture.ref,
    by: fixture.by,
    commit,
    base: commit,
    gitRef,
    verify: 'npm run test:full',
    worktree: fixture.worktree,
    body: 'No repository change. Verification completed against the declared clean scope.',
  });
  assert.equal(submitted.ok, true, `submit was refused: ${submitted.message}`);
  const submittedTicket = store.getTicket(fixture.project, fixture.ref);
  assert.equal(submittedTicket.submission.noOp, true);
  assert.deepEqual(submittedTicket.submission.commits, []);
  assert.deepEqual(submittedTicket.submission.changedPaths, []);

  const delivered = store.integrateSubmission(fixture.project, fixture.ref, {
    mode: 'replay',
    target: store.integrationTarget(fixture.project),
    skipVerify: true,
  });
  assert.equal(delivered.ok, true, `no-op integration was refused: ${delivered.message}`);
  assert.equal(delivered.integration.resultingHead, commit);
});

test('SQ-923: done still refuses a write-routed dispatch that has work in its scope', async () => {
  const dirty = isolatedDispatch('sq-mcp-dirty-', 'a923dirty', ['src']);
  fs.mkdirSync(path.join(dirty.worktree, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dirty.worktree, 'src', 'engine.js'), 'real work\n');
  const refusedDirty = await callToolRaw('done', {
    project: dirty.project,
    ref: dirty.ref,
    by: dirty.by,
    model: 'opus',
    body: 'Claiming a no-op while the declared scope holds uncommitted work.',
  });
  const dirtyAck = JSON.parse(refusedDirty.content[0].text);
  assert.equal(dirtyAck.ok, false);
  assert.equal(dirtyAck.reason, 'submission_required');
  assert.match(dirtyAck.message, /src\/engine\.js/, 'names the uncommitted path it found');
  assert.equal(store.getTicket(dirty.project, dirty.ref).status, 'doing');

  const committed = isolatedDispatch('sq-mcp-committed-', 'a923committed', ['src']);
  fs.mkdirSync(path.join(committed.worktree, 'src'), { recursive: true });
  fs.writeFileSync(path.join(committed.worktree, 'src', 'engine.js'), 'real work\n');
  gitAt(committed.worktree, ['add', '--', 'src/engine.js']);
  gitAt(committed.worktree, ['-c', 'user.name=Sidequest Tests', '-c', 'user.email=sidequest@example.invalid', 'commit', '-q', '-m', 'scoped work']);
  const refusedCommitted = await callToolRaw('done', {
    project: committed.project,
    ref: committed.ref,
    by: committed.by,
    model: 'opus',
    body: 'Committed but never submitted, which is the case the guard exists for.',
  });
  const committedAck = JSON.parse(refusedCommitted.content[0].text);
  assert.equal(committedAck.ok, false);
  assert.equal(committedAck.reason, 'submission_required');
  assert.match(committedAck.message, /committed but not submitted/);
  assert.equal(store.getTicket(committed.project, committed.ref).status, 'doing');
});

// SQ-923: executors stamp the runtime id they can actually see. "claude-fable-5"
// passes the backend slug pattern, so it reached the catalog lookup and died as
// "unknown model" on an otherwise correct closeout (eige:SQ-828, eige:SQ-913).
test('SQ-923: done accepts the runtime id an executor reports for a Claude tier', async () => {
  const project = store.ensureProject(path.join(os.tmpdir(), 'sq-mcp-model-alias'), 'SQ-923 model alias').slug;
  for (const [reported, expected] of [['claude-fable-5', 'fable'], ['claude-opus-5[1m]', 'opus'], ['sonnet-4-5', 'sonnet']]) {
    const ticket = store.createTicket(project, { title: `reported as ${reported}` });
    assert.equal(store.claimTicket(project, ticket.ref, 'alias-worker', { direct: true, reason: 'fixture claim for a provenance stamp' }).ok, true);
    const closed = await callTool('done', {
      project,
      ref: ticket.ref,
      by: 'alias-worker',
      model: reported,
      effort: 'high',
      body: `Closed with the runtime id the executor actually sees: ${reported}.`,
    });
    assert.equal(closed.ok, true, `done refused ${reported}: ${closed.message}`);
    assert.equal(store.getTicket(project, ticket.ref).workedBy.model, expected);
  }
  const unknown = await callToolRaw('done', {
    project,
    ref: store.createTicket(project, { title: 'genuinely unknown model' }).ref,
    by: 'alias-worker',
    model: 'gpt-9-imaginary',
    body: 'A model nobody routes still has to be refused by name.',
  });
  assert.equal(unknown.isError, true, 'an unknown model is still refused');
});

test('MCP add, update, and route_recipe carry a one-ticket route override', async () => {
  const category = `mcp-ticket-route-${process.pid}`;
  store.setCategory({ id: category, name: 'MCP ticket route', route: { model: 'sonnet', effort: 'medium' }, enabled: true });

  const added = await callTool('add', {
    project: PROJ,
    title: 'Use an explicit ticket route',
    category,
    route: { model: 'sonnet', effort: 'high' },
  });
  const projectSlug = added.project;
  assert.deepEqual(store.getTicket(projectSlug, added.ref)?.route, { model: 'sonnet', effort: 'high' }, 'MCP add persists the route under its acknowledged project slug');

  await callTool('update', {
    project: PROJ,
    ref: added.ref,
    route: { model: 'opus', effort: 'high' },
  });
  assert.deepEqual(store.getTicket(projectSlug, added.ref)?.route, { model: 'opus', effort: 'high' });

  const recipe = await callTool('route_recipe', { project: PROJ, category, ticket: added.ref });
  assert.deepEqual(recipe.route, { model: 'opus', effort: 'high' });
  assert.deepEqual(recipe.ticket, { ref: added.ref, route: { model: 'opus', effort: 'high' } });
});

export {};
