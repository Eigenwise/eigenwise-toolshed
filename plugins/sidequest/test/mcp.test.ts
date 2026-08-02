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
const store = require('../lib/store.js');
const DISPATCH_DESCRIPTION = 'Where: the routed test fixture. Contract: prepare a stable executor without changing the ticket title. Verify: inspect the dispatch result.';
const NO_SCOPE_WARNING = 'Planning-depth warning: no file scope declared for a write-scope ticket. Scope will be inferred from wherever the executor first writes, which can silently cap the work below what the description describes. Declare files now, or expect a possible partial submission.';

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

test('an unknown method is a JSON-RPC method-not-found error', async () => {
  const resp = await mcp.handleRequest({ jsonrpc: '2.0', id: 3, method: 'does/not/exist' });
  assert.ok(resp.error, 'returns an error object');
  assert.strictEqual(resp.error.code, -32601);
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
  const otherProject = store.ensureProject(path.join(FIXTURE_ROOT, 'other-board')).slug;
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

// SQ-923: executors stamp the runtime id they can actually see. "claude-fable-5"
// passes the backend slug pattern, so it reached the catalog lookup and died as
// "unknown model" on an otherwise correct closeout (eige:SQ-828, eige:SQ-913).
export {};
