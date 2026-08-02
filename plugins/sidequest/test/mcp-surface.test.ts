import './_temp-cleanup.js';
import './_sidequest-install-fixture.js';
'use strict';
/**
 * Every advertised MCP tool must actually run.
 *
 * The 4.0.0 strip deleted lib modules that the mcp-*.ts handlers reached through a
 * destructured require(). TypeScript types require() as any, so the tree typechecked
 * and shipped while `done`, `plan`, and `groomClose` threw "X is not a function" on
 * the first call. Nothing caught it because no test invoked the tool surface.
 *
 * This walks tools/list and calls each one. A tool that is advertised but not listed
 * here fails too, so removing a lib function without removing its tool cannot ship.
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-surface-home-'));
const PROJ = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mcp-surface-proj-'));
process.env.SIDEQUEST_HOME = HOME;
process.env.CLAUDE_PROJECT_DIR = PROJ;
execFileSync('git', ['init', '--quiet'], { cwd: PROJ, windowsHide: true });

const mcp = require('../lib/mcp.js');

let rpcId = 0;
async function call(name: string, args: Record<string, unknown>) {
  rpcId += 1;
  const res: any = await mcp.handleRequest({
    jsonrpc: '2.0', id: rpcId, method: 'tools/call', params: { name, arguments: args },
  });
  const text = res?.result?.content?.[0]?.text;
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { /* plain text result */ }
  return { rpcError: res?.error?.message || null, isError: Boolean(res?.result?.isError), parsed, text };
}

// Minimal valid arguments per tool. Order matters: earlier entries create what
// later ones consume.
const SEQUENCE: Array<[string, Record<string, unknown>]> = [
  ['add', { title: 'surface probe one' }],
  ['add', { title: 'surface probe two' }],
  ['list', {}],
  ['changes', {}],
  ['story', { action: 'add', title: 'surface story' }],
  ['update', { ref: 'SQ-1', status: 'doing' }],
  ['assign', { ref: 'SQ-1', to: 'someone' }],
  ['comment', { ref: 'SQ-1', body: 'surface comment' }],
  ['comments', { ref: 'SQ-1' }],
  ['link', { from: 'SQ-1', verb: 'related', to: 'SQ-2' }],
  ['unlink', { a: 'SQ-1', b: 'SQ-2' }],
  ['done', { ref: 'SQ-1', by: 'surface', body: 'surface closeout report' }],
  ['groomClose', { ref: 'SQ-2', by: 'surface', reason: 'surface grooming evidence' }],
  ['archive', { ref: 'SQ-1' }],
  ['unarchive', { ref: 'SQ-1' }],
  ['remove', { ref: 'SQ-2', force: true }],
];

test('every advertised tool is exercised by this file', async () => {
  const listed: any = await mcp.handleRequest({ jsonrpc: '2.0', id: 0, method: 'tools/list', params: {} });
  const advertised = listed.result.tools.map((t: any) => t.name).sort();
  const covered = [...new Set(SEQUENCE.map(([name]) => name))].sort();
  assert.deepEqual(advertised, covered,
    'tools/list and this test disagree — add the new tool to SEQUENCE, or drop the tool');
});

test('no advertised tool throws on a valid call', async () => {
  const failures: string[] = [];
  for (const [name, args] of SEQUENCE) {
    const { rpcError, isError, parsed } = await call(name, args);
    const problem = rpcError || (parsed && typeof parsed.error === 'string' ? parsed.error : null);
    // "is not a function" is the exact signature of a handler still reaching for a
    // module the strip deleted; any error at all on these arguments is a failure.
    if (problem || isError) failures.push(`${name}: ${problem || 'isError'}`);
  }
  assert.deepEqual(failures, [], `tools failed on valid arguments:\n${failures.join('\n')}`);
});

test('handlers do not reference lib modules the strip removed', () => {
  const dead = /\b(worktrees|agentsync|commitScope|execNames|requireKnownModel|provenNoOpCloseout|closeDispatchExecutor|requireDispatchSession|completeTicketAsControlPlane|writeTicketPlan)\b/;
  for (const file of ['mcp-read', 'mcp-tickets', 'mcp-lifecycle', 'mcp-collaboration']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', `${file}.ts`), 'utf8');
    assert.doesNotMatch(src, dead, `${file}.ts still references a removed module`);
  }
});
