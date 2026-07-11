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
  writeCatalogRaw(dir, JSON.stringify({ schema: 1, source: 'codex-gateway', updatedAt: new Date().toISOString(), models }));
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
  for (const expected of ['list', 'ready', 'add', 'claim', 'next', 'done', 'release', 'comment', 'ask', 'link', 'models']) {
    assert.ok(names.includes(expected), `exposes ${expected}`);
  }
  for (const t of resp.result.tools) {
    assert.strictEqual(t.inputSchema.type, 'object', `${t.name} has an object input schema`);
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
  assert.ok(callToolRaw('add', { title: 'direct', complexity: 3, why: 'x'.repeat(25), model: 'opus' }).isError, 'a direct model errors');

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

  const done = callTool('done', { ref, by: 'mcp-worker-1', model: 'sonnet', effort: 'high' });
  assert.strictEqual(done.ok, true);
  assert.strictEqual(done.ticket.status, 'done');
});

test('claim requires a worker id (no shared-identity default)', () => {
  const added = callTool('add', { title: 'needs by', complexity: 2, why: 'confirm the atomic-claim identity guard is enforced over MCP' });
  const res = callToolRaw('claim', { ref: added.ticket.ref });
  assert.ok(res.isError, 'a claim without by is refused');
  assert.match(res.content[0].text, /by.*required/i);
});

test('claim with a mismatched effort is refused (drift guard mirrors the CLI)', () => {
  const store = require('../lib/store.js');
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

test('models tool lists a discovered+enabled custom slug (discovered, enabled, and the ladder)', () => {
  seedCatalog([{ slug: 'codex-sol', id: 'claude-codex-gpt-5.6-sol[1m]', label: 'Codex Sol', anchor: 'opus' }]);
  try {
    store.setModelPrefs({ customOverrides: { 'codex-sol': { enabled: true, offset: 10 } } });
    const out = callTool('models', {});
    assert.ok(Array.isArray(out.discovered) && out.discovered.some((d) => d.slug === 'codex-sol'), 'discovered surfaces the catalog entry');
    assert.ok(out.enabled.includes('codex-sol'), 'enabled includes the custom slug alongside built-ins');
    assert.ok(out.ladder.some((r) => r.model === 'codex-sol'), 'the enabled custom reaches the ladder');
    const resolved = out.prefs.custom.find((c) => c.slug === 'codex-sol');
    assert.ok(resolved && resolved.enabled === true, 'prefs.custom is the resolved (normalized) list');
  } finally {
    store.setModelPrefs({ customOverrides: { 'codex-sol': null } });
    clearCatalog();
  }
});

test('done stamps workedBy for a discovered+enabled custom slug (provenance, not just built-ins)', () => {
  seedCatalog([{ slug: 'codex-sol', id: 'claude-codex-gpt-5.6-sol[1m]', anchor: 'opus' }]);
  try {
    store.setModelPrefs({ customOverrides: { 'codex-sol': { enabled: true } } });
    const added = callTool('add', { title: 'custom slug provenance', complexity: 2, why: 'exercise done stamping workedBy with a discovered custom model slug over MCP' });
    const ref = added.ticket.ref;
    callTool('claim', { ref, by: 'mcp-w-custom' });
    const done = callTool('done', { ref, by: 'mcp-w-custom', model: 'codex-sol', effort: 'high' });
    assert.strictEqual(done.ok, true);
    assert.ok(done.ticket.workedBy, 'a workedBy stamp was recorded');
    assert.strictEqual(done.ticket.workedBy.model, 'codex-sol', 'the stamp names the custom slug, not a built-in');
  } finally {
    store.setModelPrefs({ customOverrides: { 'codex-sol': null } });
    clearCatalog();
  }
});

test('ready with an unrecognized model errors instead of silently meaning "no filter"', () => {
  const res = callToolRaw('ready', { model: 'totally-bogus-tier' });
  assert.ok(res.isError, 'an unrecognized model filter is refused, not silently ignored');
  assert.match(res.content[0].text, /unknown model/i);
  assert.match(res.content[0].text, /totally-bogus-tier/, 'names the offending value');
});

test('claim guard refusal names the slug-qualified executor for a custom-derived tier', () => {
  seedCatalog([{ slug: 'codex-sol', id: 'claude-codex-gpt-5.6-sol[1m]', anchor: 'opus' }]);
  try {
    // offset is clamped to [-2,2] (coerceCustomOffset), so +2 anchored at opus
    // (base 4) gives base 6 — above opus itself (a tie would lose to its own
    // anchor, see custom-models.test.js) and above every other built-in EXCEPT
    // fable (base 8). Disable fable so codex-sol is the unambiguous top tier.
    store.setModelPrefs({ routing: true, fable: false, customOverrides: { 'codex-sol': { enabled: true, offset: 10 } } });
    const added = callTool('add', { title: 'custom slug guard', complexity: 10, why: 'seed a ticket that derives to the discovered custom slug so the claim guard refusal message can be checked' });
    const ref = added.ticket.ref;
    assert.strictEqual(added.ticket.model, 'codex-sol', 'the dominant custom tier wins the top complexity rung');
    const derivedEffort = added.ticket.effort;
    assert.ok(derivedEffort, 'a derived effort to mismatch against');
    const wrong = store.VALID_EFFORTS.find((e) => e !== derivedEffort);
    const res = callTool('claim', { ref, by: 'mcp-w-guard', effort: wrong });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'effort_mismatch');
    assert.match(res.message, new RegExp(`sidequest-exec-codex-sol-${derivedEffort}`), 'names the slug-qualified executor, not a built-in exec name');
  } finally {
    store.setModelPrefs({ fable: true, customOverrides: { 'codex-sol': null } });
    clearCatalog();
  }
});
