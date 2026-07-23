'use strict';
/**
 * Tests for the compact orchestration read: `--brief` on the CLI (list/ready)
 * and `brief: true` on the MCP list/ready tools.
 *
 * Why it exists (2026-07 token diet): a full ticket carries its whole
 * description and comment thread. An orchestrator re-reads the board before
 * every wave, so those bodies were paid for on every read without being
 * needed. The executor working the ticket reads the full record instead; the
 * brief shape is everything routing/batching needs and nothing else.
 *
 * Both transports serve store.listPayload/readyPayload, so the shapes cannot
 * drift: --brief implies --json on the CLI, and `waves` is ALWAYS arrays of
 * refs (brief or not, CLI or MCP).
 *
 * Run: node --test plugins/sidequest/test/brief.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { makeCliRunner, makeMcpCaller } = require('./_helpers.js');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-brief-test-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;
const PROJ = path.join(os.tmpdir(), 'sq-brief-fixtures', 'board');
process.env.CLAUDE_PROJECT_DIR = PROJ;

const mcp = require('../lib/mcp.js');

const BIN = path.join(__dirname, '..', 'bin', 'sidequest.js');
const { runCli, cliJson } = makeCliRunner(BIN, { SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: PROJ });
const { callTool } = makeMcpCaller(mcp);

// The exact key set of a brief ticket. A new field is a deliberate decision,
// not drift: every key is paid for on every orchestration read, and the
// MCP/skill docs enumerate this list.
const BRIEF_KEYS = [
  'ref', 'title', 'status', 'priority', 'complexity', 'categoryId', 'categoryName', 'route', 'effort',
  'readonlyOverride', 'direct', 'claim', 'blockedBy', 'comments', 'checkpoint',
  'submission', // pending ready-for-integration submission (SQ-398): null until an executor submits
].sort();

const READY_BRIEF_KEYS = [...BRIEF_KEYS, 'files', 'contracts'].sort();

// Seed once: one ticket with a fat body + a comment, one plain.
let refA: any;
let refDone: any;
test('seed fixtures', () => {
  const a = cliJson(['add', '-t', 'brief fixture A', '-d', 'a long developer-to-developer spec body that brief reads must not carry', '--file', 'lib/a.js', '--complexity', '3', '--why', 'a routine single-file fixture change for the brief-read tests', '--json']);
  refA = a.ticket.ref;
  const c = runCli(['comment', refA, '-m', 'a thread entry that brief reads must count, not carry']);
  assert.strictEqual(c.status, 0, c.stderr);
  // A second, file-disjoint ticket so `ready` has a real multi-ticket set.
  cliJson(['add', '-t', 'brief fixture B', '--file', 'lib/b.js', '--complexity', '5', '--why', 'an everyday one-area fixture change for the brief-read tests', '--json']);
  refDone = cliJson(['add', '-t', 'completed brief fixture', '--status', 'done', '--complexity', '2', '--why', 'a completed fixture for active-list filtering', '--json']).ticket.ref;
});

test('CLI: list --json --brief returns the compact shape only', () => {
  const out = cliJson(['list', '--json', '--brief']);
  assert.ok(out.tickets.length >= 2, 'both fixtures listed');
  for (const t of out.tickets) {
    assert.deepStrictEqual(Object.keys(t).sort(), BRIEF_KEYS, 'exactly the brief keys, no bodies, no ids');
  }
  const a = out.tickets.find((t?: any) => t.ref === refA);
  assert.match(a.route, /·/, 'brief includes one compact route descriptor');
  assert.equal(a.files, undefined, 'brief leaves declared files in the full ticket read');
  assert.equal(a.contracts, undefined, 'brief leaves contract metadata in the full ticket read');
  assert.strictEqual(a.comments, 1, 'thread is a count, not the entries');
});

test('CLI: --brief implies --json (never silently a no-op)', () => {
  const out = cliJson(['list', '--brief']);
  assert.ok(Array.isArray(out.tickets), '--brief alone must emit the JSON payload');
  assert.deepStrictEqual(Object.keys(out.tickets[0]).sort(), BRIEF_KEYS);
  const ready = cliJson(['ready', '--brief']);
  assert.ok(Array.isArray(ready.tickets) && Array.isArray(ready.waves), 'ready --brief too');
});

test('CLI: list --json (no --brief) still returns full tickets', () => {
  const out = cliJson(['list', '--json']);
  const a = out.tickets.find((t?: any) => t.ref === refA);
  assert.ok(a.description.includes('long developer-to-developer'), 'full read keeps the body');
  assert.ok(Array.isArray(a.comments), 'full read keeps the thread');
});

test('list defaults to active tickets while done reads stay directly available', async () => {
  const cliDefault = cliJson(['list', '--json']);
  assert.equal(cliDefault.tickets.some((ticket?: any) => ticket.ref === refDone), false);
  assert.ok(cliDefault.nextCursor === null || typeof cliDefault.nextCursor === 'string');

  const cliDone = cliJson(['list', '--json', '--status', 'done']);
  assert.equal(cliDone.tickets.some((ticket?: any) => ticket.ref === refDone), true);
  assert.equal(cliJson(['list', '--json', '--all']).tickets.some((ticket?: any) => ticket.ref === refDone), true);

  const mcpDefault = await callTool('list', {});
  assert.equal(mcpDefault.tickets.some((ticket?: any) => ticket.ref === refDone), false);
  assert.equal((await callTool('list', { status: 'done' })).tickets.some((ticket?: any) => ticket.ref === refDone), true);
  assert.equal((await callTool('list', { all: true })).tickets.some((ticket?: any) => ticket.ref === refDone), true);
  assert.equal((await callTool('pulse', { ref: refDone })).status, 'done');
});

test('CLI: ready --json --brief returns compact tickets + ref waves', () => {
  const out = cliJson(['ready', '--json', '--brief']);
  assert.ok(out.tickets.length >= 2, 'both fixtures are ready');
  for (const t of out.tickets) {
    assert.deepStrictEqual(Object.keys(t).sort(), READY_BRIEF_KEYS);
    assert.deepStrictEqual(t.blockedBy, [], 'ready tickets are unblocked by construction');
  }
  for (const wave of out.waves) {
    for (const r of wave) assert.match(r, /^SQ-\d+$/, 'waves are refs');
  }
});

test('MCP: list/ready with brief:true return the compact shape', async () => {
  const list = await callTool('list', {});
  for (const t of list.tickets) {
    assert.deepStrictEqual(Object.keys(t).sort(), BRIEF_KEYS);
  }
  const ready = await callTool('ready', { brief: true });
  for (const t of ready.tickets) {
    assert.deepStrictEqual(Object.keys(t).sort(), READY_BRIEF_KEYS);
  }
  for (const wave of ready.waves) {
    for (const r of wave) assert.match(String(r), /^SQ-\d+$/, 'brief waves are refs');
  }
});

test('MCP: ready defaults compact; brief:false keeps ref waves with full tickets', async () => {
  const brief = await callTool('ready', {});
  for (const ticket of brief.tickets) assert.deepStrictEqual(Object.keys(ticket).sort(), READY_BRIEF_KEYS);

  const full = await callTool('ready', { brief: false });
  for (const wave of full.waves) {
    for (const r of wave) {
      assert.strictEqual(typeof r, 'string', 'non-brief waves must also be refs, not ticket objects');
      assert.match(r, /^SQ-\d+$/);
    }
  }
  assert.ok(full.tickets.some((t?: any) => typeof t.description === 'string'), 'full tickets still ride in tickets');
});

test('MCP: list defaults compact and detail:true returns full tickets', async () => {
  const list = await callTool('list', {});
  for (const ticket of list.tickets) assert.deepStrictEqual(Object.keys(ticket).sort(), BRIEF_KEYS);
  const full = await callTool('list', { detail: true });
  const a = full.tickets.find((t?: any) => t.ref === refA);
  assert.ok(a.description.includes('long developer-to-developer'), 'detail:true keeps full bodies');
});

test('brief blockedBy resolves open blockers (in-memory index, correct field name)', () => {
  const c = cliJson(['add', '-t', 'blocked fixture C', '--file', 'lib/c.js', '--complexity', '2', '--why', 'a mechanical fixture change that depends on fixture A landing first', '--json']);
  const refC = c.ticket.ref;
  const link = runCli(['link', refC, 'depends-on', refA]);
  assert.strictEqual(link.status, 0, link.stderr);
  const out = cliJson(['list', '--brief']);
  const briefC = out.tickets.find((t?: any) => t.ref === refC);
  assert.deepStrictEqual(briefC.blockedBy, [refA], 'blockedBy carries the open blocker ref');
  const ready = cliJson(['ready', '--brief']);
  assert.ok(!ready.tickets.some((t?: any) => t.ref === refC), 'a blocked ticket is not ready');
});

test('models detail is opt-in and default list pages are capped', async () => {
  const compact = await callTool('models', {});
  assert.deepStrictEqual(Object.keys(compact.categories[0]).sort(), ['id', 'route']);
  assert.equal(compact.categories[0].route.includes('·'), true);
  assert.equal(compact.warnings, undefined);

  const full = await callTool('models', { full: true });
  assert.ok(full.categories[0].configured);
  assert.ok(full.categories[0].resolved);
  assert.ok(Array.isArray(full.categories[0].warnings));

  for (let index = 0; index < 41; index += 1) {
    cliJson(['add', '-t', `page-cap fixture ${index}`, '--complexity', '2', '--why', 'a small fixture used to confirm the default list page cap', '--json']);
  }
  const page = cliJson(['list', '--json']);
  assert.equal(page.returned, 40);
  assert.equal(page.tickets.length, 40);
  assert.equal(typeof page.nextCursor, 'string');
});

export {};
