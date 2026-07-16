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
const { spawnSync } = require('child_process');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-test-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;
const PROJ = path.join(os.tmpdir(), 'sq-mcp-fixtures', 'board');
process.env.CLAUDE_PROJECT_DIR = PROJ;
// Start with no discovery root at all — a real machine (e.g. this one, with
// codex-gateway installed) can have a genuine ~/.claude/codex-gateway/catalog.json,
// which would otherwise leak real discovered slugs into these tests. The
// SQ-162 tests below point SIDEQUEST_DISCOVERY_DIRS at their own fake catalog.
const NO_CATALOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-nocatalog-'));
process.env.SIDEQUEST_DISCOVERY_DIRS = NO_CATALOG_DIR;

const mcp = require('../lib/mcp.js');
const store = require('../lib/store.js');

// Write a fake codex-gateway catalog (mirrors test/discovery.test.js) so a
// discovered+enabled custom slug can be exercised over the MCP surface.
function writeCatalogRaw(dir, body) {
  fs.mkdirSync(path.join(dir, 'codex-gateway'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'codex-gateway', 'catalog.json'), body);
}
function seedCatalog(models) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-catalog-'));
  writeCatalogRaw(dir, JSON.stringify({ schema: 2, source: 'codex-gateway', updatedAt: new Date().toISOString(), models }));
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
  for (const expected of ['list', 'ready', 'add', 'update', 'remove', 'claim', 'sweepClaims', 'next', 'done', 'release', 'comment', 'ask', 'link', 'dispatch', 'models', 'category_detach', 'category_relink', 'archive_board', 'unarchive_board']) {
    assert.ok(names.includes(expected), `exposes ${expected}`);
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
  assert.ok(total <= 6000, `tool descriptions use ${total} bytes — trim them, don't raise the budget`);
  assert.match(tools.find((tool) => tool.name === 'claim').description, /ok:true/);
  assert.match(tools.find((tool) => tool.name === 'dispatch').description, /instant/);
  assert.match(tools.find((tool) => tool.name === 'done').description, /actual model and effort/);
});

test('sweepClaims releases stale claims through MCP', () => {
  const created = callTool('add', { title: 'MCP stale sweep', unclassified: true });
  const slug = created.project;
  assert.equal(store.claimTicket(slug, created.ticket.ref, 'mcp-stale').ok, true);
  const stale = store.getTicket(slug, created.ticket.ref);
  stale.claim.at = new Date(Date.now() - store.claimTtlMs() - 1).toISOString();
  const dbModule = require('../lib/db.js');
  dbModule.putRow(dbModule.openDb(SIDEQUEST_HOME), 'tickets', {
    id: stale.id, project: slug, ref: stale.ref, status: stale.status,
    archived: stale.archived ? 1 : 0, ord: stale.order, claim_by: stale.claim.by, data: stale,
  });
  const swept = callTool('sweepClaims', { project: slug });
  assert.equal(swept.released.length, 1);
  assert.equal(store.getTicket(slug, created.ticket.ref).claim, null);
});


test('MCP board archive tools require explicit refs and list archived boards', () => {
  const board = store.ensureProject(path.join(os.tmpdir(), 'sq-mcp-archived-board'), 'MCP Archived Board');
  store.createTicket(board.slug, { title: 'preserve me' });

  const missing = callToolRaw('archive_board', {});
  assert.ok(missing.isError);
  assert.match(missing.content[0].text, /project is required/i);

  const archived = callTool('archive_board', { project: board.slug });
  assert.strictEqual(archived.ok, true);
  assert.strictEqual(archived.project, board.slug);
  assert.ok(archived.archivedAt);

  const active = callTool('projects', {});
  assert.ok(!active.projects.some((project) => project.slug === board.slug));
  const archivedBoards = callTool('projects', { archived: true });
  assert.ok(archivedBoards.projects.some((project) => project.slug === board.slug));

  const restored = callTool('unarchive_board', { project: board.slug });
  assert.strictEqual(restored.ok, true);
  assert.strictEqual(restored.wasArchived, true);
});
test('dispatch is instant by default (stable executor + briefing + token); ephemeral writes a per-ticket def', () => {
  const d = mcp.toolDescriptors().find((t) => t.name === 'dispatch');
  assert.ok(d);
  assert.deepStrictEqual(Object.keys(d.inputSchema.properties).sort(), ['ephemeral', 'project', 'ref', 'session']);
  assert.deepStrictEqual(d.inputSchema.required, ['ref']);

  seedCatalog([{ slug: 'codex-gpt-5-6-terra', id: 'claude-codex-gpt-5.6-terra', label: 'Terra' }]);
  store.setCategory({ id: 'dispatch-codex', name: 'Dispatch Codex', route: { model: 'codex-gpt-5-6-terra', effort: 'high' } });
  const slug = store.ensureProject(PROJ).slug;

  const addedInstant = callTool('add', { title: 'instant dispatch', category: 'dispatch-codex' });
  const instant = callTool('dispatch', { ref: addedInstant.ticket.ref, session: 'mcp-dispatch-session' });
  assert.equal(instant.mode, 'instant');
  assert.equal(instant.agent, 'sidequest-exec-codex-gpt-5-6-terra-high');
  assert.equal(instant.spawn.subagent_type, instant.agent);
  assert.equal(instant.tokenPrefix, instant.token.slice(0, 12));
  assert.match(instant.briefing, new RegExp(`--token ${instant.token}`));
  assert.match(instant.briefing, /## This ticket/);
  assert.doesNotMatch(instant.briefing, /^---$/m);
  assert.match(instant.guidance, /executor/);
  assert.equal(store.getTicket(slug, addedInstant.ticket.ref).dispatchExecutor, instant.agent);

  const addedEphemeral = callTool('add', { title: 'ephemeral dispatch', category: 'dispatch-codex' });
  const ephemeral = callTool('dispatch', { ref: addedEphemeral.ticket.ref, session: 'mcp-dispatch-session', ephemeral: true });
  assert.equal(ephemeral.mode, 'ephemeral');
  assert.match(ephemeral.agent, new RegExp(`^sidequest-ticket-${addedEphemeral.ticket.ref.toLowerCase()}-gpt-5-6-terra-[a-f0-9]{8}$`));
  assert.equal(ephemeral.tokenPrefix, ephemeral.token.slice(0, 12));
  assert.equal(store.getTicket(slug, addedEphemeral.ticket.ref).dispatchExecutor, ephemeral.agent);
});

test('native_agent carries ticket anchors and verify command through its stable fallback', () => {
  seedCatalog([{ slug: 'codex-gpt-5-6-terra', id: 'claude-codex-gpt-5.6-terra', label: 'Terra' }]);
  try {
    store.setCategory({ id: 'native-codex', name: 'Native Codex', route: { model: 'codex-gpt-5-6-terra', effort: 'high' } });
    const added = callTool('add', {
      title: 'prompt context', category: 'native-codex',
      anchors: 'lib/work.js:14 executorPrompt', verify: 'node --test plugins/sidequest/test/work.test.js',
    });
    const native = callTool('native_agent', { ref: added.ticket.ref, prompt: 'Implement exactly this ticket.' });
    assert.strictEqual(native.fallback, true);
    assert.strictEqual(native.file, null);
    assert.strictEqual(native.spawn.subagent_type, 'sidequest-exec-codex-gpt-5-6-terra-high');
    assert.match(native.prompt, /Authoritative ticket contract \(the task prompt may add logistics only; do not narrow this scope\):/);
    assert.match(native.prompt, /Title: prompt context/);
    assert.match(native.prompt, /Anchors:\nlib\/work\.js:14 executorPrompt/);
    assert.match(native.prompt, /Verify command:\nnode --test plugins\/sidequest\/test\/work\.test\.js/);
  } finally {
    clearCatalog();
  }
});
test('an unknown method is a JSON-RPC method-not-found error', () => {
  const resp = mcp.handleRequest({ jsonrpc: '2.0', id: 3, method: 'does/not/exist' });
  assert.ok(resp.error, 'returns an error object');
  assert.strictEqual(resp.error.code, -32601);
});

test('add enforces complexity + why and rejects direct model/effort', () => {
  // Missing complexity/why -> isError.
  assert.ok(callToolRaw('add', { title: 'no score' }).isError, 'missing complexity/why errors');
  assert.ok(callToolRaw('add', { title: 'bad', complexity: 3, why: 'too short' }).isError, 'a thin why errors');
  assert.ok(callToolRaw('add', { title: 'direct', complexity: 3, why: 'x'.repeat(25), model: 'grade-3' }).isError, 'a direct model errors');

  const out = callTool('add', { title: 'MCP add works', complexity: 3, why: 'a real motivation referencing the actual single-file change' });
  assert.strictEqual(out.ok, true);
  assert.match(out.ticket.ref, /^SQ-\d+$/);
  assert.strictEqual(out.ticket.complexity, 3);
  assert.ok(out.ticket.model, 'routing is derived and stamped');
});

test('update echoes freshly resolved routing after changing category', () => {
  store.setCategory({ id: 'mcp-update-echo', name: 'MCP update echo', route: { model: 'opus', effort: 'high' } });
  const added = callTool('add', { title: 'MCP update echo', category: 'mechanical' });
  const updated = callTool('update', { ref: added.ticket.ref, category: 'mcp-update-echo' });
  assert.strictEqual(updated.ticket.categoryId, 'mcp-update-echo');
  assert.strictEqual(updated.ticket.category.id, 'mcp-update-echo');
  assert.strictEqual(updated.ticket.model, 'opus');
  assert.strictEqual(updated.ticket.effort, 'high');
  assert.strictEqual(updated.ticket.exec.model, 'opus');
});

test('status validation fails loudly and directs deletion to remove', () => {
  const added = callTool('add', { title: 'strict status', complexity: 1, why: 'exercise loud validation for invalid MCP status values' });
  const invalid = callToolRaw('update', { ref: added.ticket.ref, status: 'deleted' });
  assert.ok(invalid.isError);
  assert.match(invalid.content[0].text, /Valid statuses: todo, doing, done/);
  assert.match(invalid.content[0].text, /remove tool/i);
  assert.throws(() => store.updateTicket(store.ensureProject(PROJ).slug, added.ticket.ref, { status: 'deleted' }), /remove tool/i);
  assert.throws(() => store.createTicket(store.ensureProject(PROJ).slug, { title: 'bad status', status: 'deleted' }), /remove tool/i);
});

test('remove permanently deletes tickets and protects live claims without force', () => {
  const added = callTool('add', { title: 'remove me', complexity: 1, why: 'exercise permanent MCP ticket removal and list disappearance' });
  const removed = callTool('remove', { ref: added.ticket.ref });
  assert.strictEqual(removed.ok, true);
  assert.deepStrictEqual(removed.removed, { ref: added.ticket.ref, title: 'remove me' });
  assert.ok(!callTool('list', {}).tickets.some((ticket) => ticket.ref === added.ticket.ref));

  const claimed = callTool('add', { title: 'claimed remove', complexity: 1, why: 'exercise refusal when a ticket has a live executor claim' });
  const claim = callTool('claim', { ref: claimed.ticket.ref, by: 'mcp-remove-worker' });
  assert.strictEqual(claim.ok, true);
  const refused = callTool('remove', { ref: claimed.ticket.ref });
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.reason, 'claimed');
  const forced = callTool('remove', { ref: claimed.ticket.ref, force: true });
  assert.strictEqual(forced.ok, true);
});

test('claim -> comment -> done round-trips over the same store, tagged source mcp', () => {
  const added = callTool('add', { title: 'work me', complexity: 2, why: 'a mechanical change to exercise the claim/done path over MCP' });
  const ref = added.ticket.ref;

  const claim = callTool('claim', { ref, by: 'mcp-worker-1' });
  assert.strictEqual(claim.ok, true);
  assert.strictEqual(claim.ticket.status, 'doing');

  const note = callTool('comment', { ref, body: 'progress note from an MCP tool call' });
  assert.strictEqual(note.ok, true);
  assert.strictEqual(note.comment.source, 'mcp', 'MCP actions are tagged as background (not dashboard)');

  const done = callTool('done', { ref, by: 'mcp-worker-1', model: added.ticket.model, effort: added.ticket.effort });
  assert.strictEqual(done.ok, true);
  assert.strictEqual(done.ticket.status, 'done');
});

test('SQ-174: a spaced comment round-trips with spaces intact and no NUL bytes', () => {
  const added = callTool('add', { title: 'spaces intact', complexity: 1, why: 'exercise the MCP comment write path preserves internal spaces verbatim' });
  const ref = added.ticket.ref;
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
  const ref = added.ticket.ref;
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

test('SQ-173: an over-cap comment is rejected, not silently truncated', () => {
  const added = callTool('add', { title: 'over cap', complexity: 1, why: 'confirm the MCP comment tool rejects a body past the 4k cap instead of cutting it' });
  const ref = added.ticket.ref;

  // A body one char over the cap must fail loudly, and nothing may be stored.
  const tooLong = 'x'.repeat(4001);
  const rejected = callTool('comment', { ref, body: tooLong });
  assert.strictEqual(rejected.ok, false, 'the write is rejected');
  assert.strictEqual(rejected.reason, 'too_long');
  assert.strictEqual(rejected.max, 4000, 'the error names the cap');
  assert.strictEqual(rejected.length, 4001, 'the error names the actual length');
  const back = callTool('comments', { ref });
  assert.strictEqual(back.comments.length, 0, 'no truncated comment leaked into storage');

  // A body exactly at the cap still stores whole (the boundary is inclusive).
  const atCap = 'y'.repeat(4000);
  const ok = callTool('comment', { ref, body: atCap });
  assert.strictEqual(ok.ok, true, 'a body exactly at the cap stores');
  const back2 = callTool('comments', { ref });
  assert.strictEqual(back2.comments[0].body.length, 4000, 'stored whole, not cut');
});

test('claim requires a worker id (no shared-identity default)', () => {
  const added = callTool('add', { title: 'needs by', complexity: 2, why: 'confirm the atomic-claim identity guard is enforced over MCP' });
  const res = callToolRaw('claim', { ref: added.ticket.ref });
  assert.ok(res.isError, 'a claim without by is refused');
  assert.match(res.content[0].text, /by.*required/i);
});

test('MCP claim passes prepared dispatch token and executor through to the store', () => {
  seedCatalog([{ id: 'claude-codex-gpt-5.6-terra[1m]', slug: 'codex-gpt-5-6-terra', label: 'GPT-5.6 Terra' }]);
  store.setCategory({ id: 'mcp-dispatch-claim', name: 'MCP dispatch claim', route: { model: 'codex-gpt-5-6-terra', effort: 'high' } });
  const added = callTool('add', { title: 'nonce through MCP', category: 'mcp-dispatch-claim' });
  const slug = store.ensureProject(PROJ).slug;
  const prepared = store.prepareDispatch(slug, added.ticket.ref);
  const refused = callTool('claim', { ref: added.ticket.ref, by: 'mcp-no-token' });
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.reason, 'token');
  const accepted = callTool('claim', { ref: added.ticket.ref, by: 'mcp-with-token', token: prepared.token, executor: prepared.ticket.dispatchExecutor });
  assert.strictEqual(accepted.ok, true);
});

test('MCP claim rejects a generic executor for a Codex route', () => {
  seedCatalog([{ id: 'claude-codex-gpt-5.6-terra[1m]', slug: 'codex-gpt-5-6-terra', label: 'GPT-5.6 Terra' }]);
  try {
    store.setCategory({ id: 'claim-codex', name: 'Claim Codex', route: { model: 'codex-gpt-5-6-terra', effort: 'high' } });
    const added = callTool('add', { title: 'Codex executor guard', category: 'claim-codex' });
    const ticket = store.getTicket(store.ensureProject(PROJ).slug, added.ticket.ref);
    const rejected = callTool('claim', { ref: added.ticket.ref, by: 'mcp-generic', effort: ticket.effort, executor: `sidequest-exec-${ticket.effort}` });
    assert.strictEqual(rejected.ok, false);
    assert.strictEqual(rejected.reason, 'executor_mismatch');
    assert.strictEqual(rejected.expectedExecutor, ticket.exec.agent);
  } finally {
    clearCatalog();
  }
});

test('claim with a mismatched effort is refused (drift guard mirrors the CLI)', () => {
  const added = callTool('add', { title: 'effort guard', category: 'mechanical' });
  const ref = added.ticket.ref;
  const derived = added.ticket.effort;
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

test('the real stdio server frames newline-delimited JSON-RPC', () => {
  const BIN = path.join(__dirname, '..', 'bin', 'sidequest-mcp.js');
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'projects', arguments: {} } },
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
  assert.ok(!parsed[2].result.isError, 'projects tool call succeeded');
});

test('models reports concrete routes and no grade output', () => {
  seedCatalog([{ slug: 'codex-terra', id: 'claude-codex-gpt-5.6-terra[1m]', label: 'Codex Terra' }]);
  try {
    store.setCategory({ id: 'model-codex', name: 'Model Codex', route: { model: 'codex-terra', effort: 'high' }, fallback: { model: 'opus', effort: 'high' } });
    const out = callTool('models', {});
    assert.ok(out.models.includes('codex-terra'));
    assert.ok(out.categories.some((category) => category.id === 'model-codex' && category.resolved.model === 'codex-terra'));
    assert.ok(!JSON.stringify(out).includes('grade-'));
  } finally {
    clearCatalog();
  }
});

test('done stamps workedBy with a discovered Codex slug', () => {
  seedCatalog([{ slug: 'codex-terra', id: 'claude-codex-gpt-5.6-terra[1m]' }]);
  try {
    store.setCategory({ id: 'provenance-codex', name: 'Provenance Codex', route: { model: 'codex-terra', effort: 'high' } });
    const added = callTool('add', { title: 'codex provenance', category: 'provenance-codex' });
    const ref = added.ticket.ref;
    callTool('claim', { ref, by: 'mcp-w-codex' });
    const done = callTool('done', { ref, by: 'mcp-w-codex', model: 'codex-terra', effort: 'high' });
    assert.strictEqual(done.ok, true);
    assert.strictEqual(done.ticket.workedBy.model, 'codex-terra');
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
    const wrong = store.VALID_EFFORTS.find((effort) => effort !== added.ticket.effort);
    const res = callTool('claim', { ref: added.ticket.ref, by: 'mcp-w-guard', effort: wrong });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'effort_mismatch');
    assert.match(res.message, new RegExp(`sidequest-exec-codex-terra-${added.ticket.effort}`));
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
