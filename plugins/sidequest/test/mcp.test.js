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
  for (const expected of ['list', 'ready', 'add', 'claim', 'next', 'done', 'release', 'comment', 'ask', 'link', 'dispatch', 'models']) {
    assert.ok(names.includes(expected), `exposes ${expected}`);
  }
  for (const t of resp.result.tools) {
    assert.strictEqual(t.inputSchema.type, 'object', `${t.name} has an object input schema`);
  }
});

test('dispatch schema is narrowly scoped and has no caller model/prompt/permission override', () => {
  const d = mcp.toolDescriptors().find((t) => t.name === 'dispatch');
  assert.ok(d);
  assert.deepStrictEqual(Object.keys(d.inputSchema.properties).sort(), ['project', 'ref']);
  assert.deepStrictEqual(d.inputSchema.required, ['ref']);
  assert.match(d.description, /bypass permissions/i);
});

test('dispatch refuses a claimed ticket before launching', () => {
  const added = callTool('add', { title: 'dispatch refusal', complexity: 2, why: 'confirm MCP dispatch refuses a ticket already owned by another worker' });
  callTool('claim', { ref: added.ticket.ref, by: 'dispatch-other' });
  const res = callToolRaw('dispatch', { ref: added.ticket.ref });
  assert.ok(res.isError);
  assert.match(res.content[0].text, /doing|release.*todo/i);
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

test('claim -> comment -> done round-trips over the same store, tagged source mcp', () => {
  const added = callTool('add', { title: 'work me', complexity: 2, why: 'a mechanical change to exercise the claim/done path over MCP' });
  const ref = added.ticket.ref;

  const claim = callTool('claim', { ref, by: 'mcp-worker-1' });
  assert.strictEqual(claim.ok, true);
  assert.strictEqual(claim.ticket.status, 'doing');

  const note = callTool('comment', { ref, body: 'progress note from an MCP tool call' });
  assert.strictEqual(note.ok, true);
  assert.strictEqual(note.comment.source, 'mcp', 'MCP actions are tagged as background (not dashboard)');

  const done = callTool('done', { ref, by: 'mcp-worker-1', model: 'grade-2', effort: 'high' });
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

test('MCP claim rejects a generic executor for a Codex route', () => {
  const dir = seedCatalog([{ id: 'claude-codex-gpt-5.6-terra[1m]', slug: 'codex-gpt-5-6-terra', label: 'GPT-5.6 Terra' }]);
  try {
    store.setModelPrefs({ routing: true, tierBackend: { 'grade-2': 'codex-gpt-5-6-terra' } });
    const added = callTool('add', { title: 'Codex executor guard', complexity: 5, why: 'exercise MCP refusal when a generic executor claims a Codex-backed route' });
    const ticket = store.getTicket(store.ensureProject(PROJ).slug, added.ticket.ref);
    const rejected = callTool('claim', { ref: added.ticket.ref, by: 'mcp-generic', effort: ticket.effort, executor: `sidequest-exec-${ticket.effort}` });
    assert.strictEqual(rejected.ok, false);
    assert.strictEqual(rejected.reason, 'executor_mismatch');
    assert.strictEqual(rejected.expectedExecutor, ticket.exec.agent);
  } finally {
    clearCatalog();
    seedCatalog([{ id: 'claude-codex-gpt-5.6-terra[1m]', slug: 'codex-gpt-5-6-terra', label: 'GPT-5.6 Terra' }]);
    store.setModelPrefs({ routing: true, tierBackend: { 'grade-2': 'claude', 'grade-3': 'claude' } });
  }
});

test('claim with a mismatched effort is refused (drift guard mirrors the CLI)', () => {
  store.setModelPrefs({ routing: true });
  const added = callTool('add', { title: 'effort guard', complexity: 5, why: 'seed a ticket whose derived effort the MCP claim guard checks' });
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

/* ------------------------------------------------------------------ *
 *  SQ-162: MCP surfaces are slug-aware — a discovered+enabled custom
 *  model tier (SQ-157) behaves like a built-in across models/ready/
 *  done/claim, and an unrecognized model value is refused rather than
 *  silently treated as "no filter".
 * ------------------------------------------------------------------ */

test('models tool surfaces the tier-backend map, detected models, and warnings', () => {
  seedCatalog([{ slug: 'codex-terra', id: 'claude-codex-gpt-5.6-terra[1m]', label: 'Codex Terra', suggestedTier: 'grade-3' }]);
  try {
    store.setModelPrefs({ tierBackend: { 'grade-3': 'codex-terra' } });
    const out = callTool('models', {});
    assert.ok(Array.isArray(out.discovered) && out.discovered.some((d) => d.slug === 'codex-terra'), 'discovered surfaces the catalog entry');
    assert.strictEqual(out.tierBackend['grade-3'], 'codex-terra', 'the tier backend map is reported');
    assert.strictEqual(out.tierBackendResolved["grade-3"].backend, 'codex', 'the resolved backend says opus runs on Codex');
    assert.ok(out.ladder.some((r) => r.model === 'grade-3'), 'the ladder still names the built-in tier');
    assert.deepStrictEqual(out.tierBackendWarnings, [], 'no warnings when the mapping is live');
  } finally {
    store.setModelPrefs({ tierBackend: { 'grade-3': 'claude' } });
    clearCatalog();
  }
});

test('done stamps workedBy with a discovered Codex slug (provenance of what actually ran)', () => {
  seedCatalog([{ slug: 'codex-terra', id: 'claude-codex-gpt-5.6-terra[1m]', suggestedTier: 'grade-3' }]);
  try {
    store.setModelPrefs({ tierBackend: { 'grade-3': 'codex-terra' } });
    const added = callTool('add', { title: 'codex provenance', complexity: 2, why: 'exercise done stamping workedBy with a discovered Codex model slug over MCP' });
    const ref = added.ticket.ref;
    callTool('claim', { ref, by: 'mcp-w-codex' });
    const done = callTool('done', { ref, by: 'mcp-w-codex', model: 'codex-terra', effort: 'high' });
    assert.strictEqual(done.ok, true);
    assert.strictEqual(done.ticket.workedBy.model, 'codex-terra', 'the stamp records the Codex model that ran');
  } finally {
    store.setModelPrefs({ tierBackend: { 'grade-3': 'claude' } });
    clearCatalog();
  }
});

test('ready with an unrecognized model errors instead of silently meaning "no filter"', () => {
  const res = callToolRaw('ready', { model: 'totally-bogus-tier' });
  assert.ok(res.isError, 'an unrecognized model filter is refused, not silently ignored');
  assert.match(res.content[0].text, /unknown model/i);
  assert.match(res.content[0].text, /totally-bogus-tier/, 'names the offending value');
});

test('claim guard refusal names the Codex-backed executor for a Codex-mapped tier', () => {
  seedCatalog([{ slug: 'codex-terra', id: 'claude-codex-gpt-5.6-terra[1m]', suggestedTier: 'grade-3' }]);
  try {
    // Point the opus tier at Codex, then file a ticket that derives to opus and
    // claim it at the wrong effort. The refusal must name the Codex-backed exec.
    const prefs = store.setModelPrefs({ routing: true, tierBackend: { 'grade-3': 'codex-terra' } });
    // find a complexity that derives to opus with a non-max effort
    const rung = store.routingLadder(prefs).find((r) => r.model === 'grade-3' && r.effort && r.effort !== 'max');
    assert.ok(rung, 'some complexity derives to opus');
    const added = callTool('add', { title: 'codex guard', complexity: rung.complexity, why: 'seed a ticket that derives to the opus tier so the claim guard refusal names the Codex-backed executor' });
    const ref = added.ticket.ref;
    assert.strictEqual(added.ticket.model, 'grade-3', 'the ticket derived to the opus tier');
    assert.strictEqual(added.ticket.exec.backend, 'codex', 'and its exec is Codex-backed');
    const derivedEffort = added.ticket.effort;
    const wrong = store.VALID_EFFORTS.find((e) => e !== derivedEffort && e !== 'max');
    const res = callTool('claim', { ref, by: 'mcp-w-guard', effort: wrong });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'effort_mismatch');
    assert.match(res.message, new RegExp(`sidequest-exec-codex-terra-${derivedEffort}`), 'names the Codex-backed executor');
  } finally {
    store.setModelPrefs({ tierBackend: { 'grade-3': 'claude' } });
    clearCatalog();
  }
});
