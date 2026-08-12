import './_sidequest-install-fixture.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-context-budget-home-'));
const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-context-budget-board-'));
process.env.SIDEQUEST_HOME = home;
process.env.CLAUDE_PROJECT_DIR = projectPath;
process.env.CLAUDE_CODE_SESSION_ID = `context-budget-${process.pid}`;
process.env.SIDEQUEST_COMPACTION_POLICY = 'pin';
process.env.CLAUDE_PLUGIN_ROOT = path.join(__dirname, '..');
execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: projectPath, windowsHide: true });
execFileSync('git', ['-c', 'user.name=Sidequest Tests', '-c', 'user.email=sidequest@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'fixture'], { cwd: projectPath, windowsHide: true });
fs.writeFileSync(path.join(projectPath, 'fixture.ts'), 'export {};\n');

const store = require('../lib/store.js');
const mcp = require('../lib/mcp.js');
const agentsync = require('../lib/agentsync.js');
const { compactionPolicyOutput } = require('../src/hooks/shared/compaction-policy.ts');

let requestId = 0;
async function callTool(name: string, args: Record<string, unknown>) {
  const response = await mcp.handleRequest({
    jsonrpc: '2.0', id: ++requestId, method: 'tools/call',
    params: { name, arguments: args },
  });
  assert.ok(response.result && !response.result.isError, `${name} failed: ${response.result?.content?.[0]?.text}`);
  return JSON.parse(response.result.content[0].text);
}

async function callToolRaw(name: string, args: Record<string, unknown>) {
  const response = await mcp.handleRequest({
    jsonrpc: '2.0', id: ++requestId, method: 'tools/call',
    params: { name, arguments: args },
  });
  return response.result;
}

async function recoverBody(retrieval: Record<string, any>) {
  let cursor = retrieval.arguments.cursor;
  let body = '';
  while (cursor !== null) {
    const page = await callTool('context_page', { ...retrieval.arguments, cursor, limit: 1024 });
    body += page.body;
    cursor = page.nextCursor;
  }
  return body;
}

function hookOutput(expression: string) {
  const outputModule = path.join(__dirname, '..', 'src', 'hooks', 'shared', 'output.ts');
  return JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '-e', `const output = require(${JSON.stringify(outputModule)}); ${expression};`], {
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: path.join(__dirname, '..') },
  }));
}

test('end-to-end context budgets preserve real storage, retrieval, and model seams', async () => {
  const project = store.ensureProject(projectPath).slug;
  const story = store.createStory(project, { title: 'Context budget benchmark' });
  store.updateStory(project, story.ref, { executionContract: `Contract ${'測🧪'.repeat(5000)}` });
  store.setProjectCategory(project, 'benchmark', 'ADD', {
    id: 'benchmark', name: 'Benchmark', description: 'Synthetic benchmark route', contract: 'Run the benchmark.',
    route: { model: 'sonnet', effort: 'low' }, fallback: null, enabled: true,
  });

  const description = `Exact Unicode body ${'測🧪é界'.repeat(9000)}`;
  const tickets = [];
  for (let index = 0; index < 28; index += 1) {
    tickets.push(store.createTicket(project, {
      title: `Synthetic context ticket ${index}`, description: `${description} ticket=${index}`,
      storyId: story.id, category: 'benchmark', files: ['fixture.ts'], source: 'context-budget-benchmark',
    }));
  }
  for (let index = 0; index < 12; index += 1) {
    store.addComment(project, tickets[0].ref, {
      by: 'benchmark', kind: index === 0 ? 'decision' : 'comment', source: 'context-budget-benchmark',
      body: `Nested exact body ${index} ${'界é🙂'.repeat(6000)}`,
    });
  }

  const durable = store.listTickets(project);
  const durableBytes = Buffer.byteLength(JSON.stringify({ tickets: durable }), 'utf8');
  assert.ok(durableBytes > 700 * 1024, `durable fixture only measured ${durableBytes} bytes`);

  const listRaw = await callToolRaw('list', { project, detail: true });
  assert.ok(!listRaw.isError);
  const listText = listRaw.content[0].text;
  const listPayload = JSON.parse(listText);
  const modelBytes = Buffer.byteLength(listText, 'utf8');
  assert.ok(modelBytes <= 13 * 1024, `bounded MCP list is ${modelBytes} bytes`);
  assert.ok(listPayload.retrieval || listPayload.ticketRetrieval || listPayload.ticketsRetrieval, 'bounded list emits continuation');

  const detail = await callTool('list', { project, ref: tickets[0].ref });
  assert.equal(detail.ticket.descriptionTruncated, true);
  assert.equal(await recoverBody(detail.ticket.descriptionRetrieval), `${description} ticket=0`);
  const comments = await callTool('comments', { project, ref: tickets[0].ref });
  assert.ok(Buffer.byteLength(JSON.stringify(comments), 'utf8') <= 13 * 1024);

  const unchanged = await callTool('list', { project, ref: tickets[0].ref });
  assert.equal(unchanged.ticket.descriptionRetrieval.arguments.cursor, detail.ticket.descriptionRetrieval.arguments.cursor);
  store.updateTicket(project, tickets[0].ref, { description: `${description} mutated` });
  const stale = await callToolRaw('context_page', { ...detail.ticket.descriptionRetrieval.arguments, limit: 1024 });
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /stale list handle/);

  const prepared = store.prepareDispatch(project, tickets[1].ref, { sessionId: 'benchmark-dispatch' });
  const briefing = agentsync.renderTicketBriefing(prepared.ticket, 'benchmark-token', project, projectPath);
  assert.ok(Buffer.byteLength(briefing, 'utf8') <= 24 * 1024);
  assert.match(briefing, /Aggregate budget: 24576 bytes/);
  const orientationTicket = store.createTicket(project, {
    title: 'Bounded orientation', description: 'Where: fixture.ts. Contract: preserve the board and keep the bounded executor orientation stable. Verify: run the benchmark command and inspect the byte count.',
    category: 'benchmark', files: ['fixture.ts'], executorVerify: 'node --test fixture.ts', source: 'context-budget-benchmark',
  });
  const dispatch = await callToolRaw('dispatch', { project, ref: orientationTicket.ref });
  assert.ok(!dispatch.isError, dispatch.content?.[0]?.text);
  assert.ok(Buffer.byteLength(dispatch.content[0].text, 'utf8') <= 1320, `dispatch is ${Buffer.byteLength(dispatch.content[0].text)} bytes`);

  const context = hookOutput("output.writeContext('SessionStart', 'Recover with the typed board call. ' + '🙂'.repeat(4000))");
  const contextText = context.hookSpecificOutput.additionalContext;
  assert.ok(Buffer.byteLength(contextText, 'utf8') <= 2048);
  const denial = hookOutput("output.writeDeny('PreToolUse', 'Recover with the typed board call. ' + '界'.repeat(4000))");
  assert.ok(Buffer.byteLength(denial.hookSpecificOutput.permissionDecisionReason, 'utf8') <= 768);

  const claimPreparation = store.prepareDispatch(project, tickets[2].ref, { sessionId: 'benchmark-claim' });
  const claimed = store.claimTicket(project, tickets[2].ref, 'context-budget-benchmark', {
    token: claimPreparation.token,
    executor: claimPreparation.ticket.dispatchExecutor,
  });
  assert.equal(claimed.ok, true);
  const compaction = await compactionPolicyOutput({ hook_event_name: 'PreCompact', trigger: 'auto', cwd: projectPath, session_id: 'benchmark-compaction' });
  assert.ok(Buffer.byteLength(compaction, 'utf8') <= 1500, `compaction output is ${Buffer.byteLength(compaction, 'utf8')} bytes`);

  const ceilingTicket = store.createTicket(project, {
    title: 'Context page ceiling control',
    description: 'x'.repeat(16000),
    category: 'benchmark', files: ['fixture.ts'], source: 'context-budget-benchmark',
  });
  const ceilingDetail = await callTool('list', { project, ref: ceilingTicket.ref });
  const ceilingRetrieval = ceilingDetail.ticket.descriptionRetrieval;
  assert.ok(ceilingRetrieval, 'oversized body exposes a context_page retrieval');
  const overBudgetPage = await callToolRaw('context_page', {
    ...ceilingRetrieval.arguments,
    limit: 16 * 1024,
  });
  assert.ok(!overBudgetPage.isError, overBudgetPage.content?.[0]?.text);
  const overBudgetText = overBudgetPage.content[0].text;
  assert.ok(Buffer.byteLength(overBudgetText, 'utf8') <= 16 * 1024, `context_page response is ${Buffer.byteLength(overBudgetText, 'utf8')} bytes`);
  const overBudgetPayload = JSON.parse(overBudgetText);
  assert.ok(overBudgetPayload.pageBytes <= 14 * 1024, `context_page payload is ${overBudgetPayload.pageBytes} bytes`);
  assert.ok(overBudgetPayload.nextCursor, 'over-limit context_page request remains paged');

  const approximateTokens = Math.ceil(durableBytes / 4);
  const boundedTokens = Math.ceil(Math.max(modelBytes, Buffer.byteLength(briefing, 'utf8')) / 4);
  process.stdout.write(`context benchmark durable=${durableBytes}B modelList=${modelBytes}B briefing=${Buffer.byteLength(briefing, 'utf8')}B approxTokens=${approximateTokens}->${boundedTokens}\n`);
});
