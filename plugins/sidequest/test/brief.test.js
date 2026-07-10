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
  'ref', 'title', 'status', 'priority', 'complexity', 'model', 'effort',
  'files', 'claim', 'blockedBy', 'comments', 'awaitingReply',
].sort();

// Seed once: one ticket with a fat body + a comment, one plain.
let refA;
test('seed fixtures', () => {
  const a = cliJson(['add', '-t', 'brief fixture A', '-d', 'a long developer-to-developer spec body that brief reads must not carry', '--file', 'lib/a.js', '--complexity', '3', '--why', 'a routine single-file fixture change for the brief-read tests', '--json']);
  refA = a.ticket.ref;
  const c = runCli(['comment', refA, '-m', 'a thread entry that brief reads must count, not carry']);
  assert.strictEqual(c.status, 0, c.stderr);
  // A second, file-disjoint ticket so `ready` has a real multi-ticket set.
  cliJson(['add', '-t', 'brief fixture B', '--file', 'lib/b.js', '--complexity', '5', '--why', 'an everyday one-area fixture change for the brief-read tests', '--json']);
});

test('CLI: list --json --brief returns the compact shape only', () => {
  const out = cliJson(['list', '--json', '--brief']);
  assert.ok(out.tickets.length >= 2, 'both fixtures listed');
  for (const t of out.tickets) {
    assert.deepStrictEqual(Object.keys(t).sort(), BRIEF_KEYS, 'exactly the brief keys, no bodies, no ids');
  }
  const a = out.tickets.find((t) => t.ref === refA);
  assert.ok(a.model && a.effort !== undefined, 'derived routing is stamped on the brief read');
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
  const a = out.tickets.find((t) => t.ref === refA);
  assert.ok(a.description.includes('long developer-to-developer'), 'full read keeps the body');
  assert.ok(Array.isArray(a.comments), 'full read keeps the thread');
});

test('CLI: ready --json --brief returns compact tickets + ref waves', () => {
  const out = cliJson(['ready', '--json', '--brief']);
  assert.ok(out.tickets.length >= 2, 'both fixtures are ready');
  for (const t of out.tickets) {
    assert.deepStrictEqual(Object.keys(t).sort(), BRIEF_KEYS);
    assert.deepStrictEqual(t.blockedBy, [], 'ready tickets are unblocked by construction');
  }
  for (const wave of out.waves) {
    for (const r of wave) assert.match(r, /^SQ-\d+$/, 'waves are refs');
  }
});

test('MCP: list/ready with brief:true return the compact shape', () => {
  const list = callTool('list', { brief: true });
  for (const t of list.tickets) {
    assert.deepStrictEqual(Object.keys(t).sort(), BRIEF_KEYS);
  }
  const ready = callTool('ready', { brief: true });
  for (const t of ready.tickets) {
    assert.deepStrictEqual(Object.keys(t).sort(), BRIEF_KEYS);
  }
  for (const wave of ready.waves) {
    for (const r of wave) assert.match(String(r), /^SQ-\d+$/, 'brief waves are refs');
  }
});

test('MCP: waves are refs with and without brief (one shape per field)', () => {
  const full = callTool('ready', {});
  for (const wave of full.waves) {
    for (const r of wave) {
      assert.strictEqual(typeof r, 'string', 'non-brief waves must also be refs, not ticket objects');
      assert.match(r, /^SQ-\d+$/);
    }
  }
  assert.ok(full.tickets.some((t) => typeof t.description === 'string'), 'full tickets still ride in tickets');
});

test('MCP: list without brief still returns full tickets', () => {
  const list = callTool('list', {});
  const a = list.tickets.find((t) => t.ref === refA);
  assert.ok(a.description.includes('long developer-to-developer'), 'full read keeps the body');
});

test('brief blockedBy resolves open blockers (in-memory index, correct field name)', () => {
  const c = cliJson(['add', '-t', 'blocked fixture C', '--file', 'lib/c.js', '--complexity', '2', '--why', 'a mechanical fixture change that depends on fixture A landing first', '--json']);
  const refC = c.ticket.ref;
  const link = runCli(['link', refC, 'depends-on', refA]);
  assert.strictEqual(link.status, 0, link.stderr);
  const out = cliJson(['list', '--brief']);
  const briefC = out.tickets.find((t) => t.ref === refC);
  assert.deepStrictEqual(briefC.blockedBy, [refA], 'blockedBy carries the open blocker ref');
  const ready = cliJson(['ready', '--brief']);
  assert.ok(!ready.tickets.some((t) => t.ref === refC), 'a blocked ticket is not ready');
});
