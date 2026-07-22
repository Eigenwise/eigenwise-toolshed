import test from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { makeCliRunner, makeMcpCaller } from './_helpers.js';

type UnknownRecord = Record<string, unknown>;
interface TicketObservation {
  source_event_id: string;
  ticket_ref: string;
  project_id?: string;
  task_id?: string;
  route_id?: string;
  session_id?: string;
  agent_id?: string;
  attributes: UnknownRecord;
}
interface Pulse {
  ref: string;
  comments: number;
  claim: { ageMs: number; at: string; by: string };
  lastComment: { at: string; by: string; kind: string; body: string };
  git: { commit: { hash: string }; dirty: boolean };
  [key: string]: unknown;
}
interface Changes {
  project: unknown;
  projectName: string;
  serverTime: string;
  since: string;
  tickets: Array<{
    ref: string;
    updatedAt: string;
    lastEventType: string;
    lastEventSource: string;
    [key: string]: unknown;
  }>;
}

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-telemetry-home-'));
const PROJ = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-telemetry-project-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;
process.env.CLAUDE_PROJECT_DIR = PROJ;
execFileSync('git', ['init', '--quiet'], { cwd: PROJ });
execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: PROJ });
execFileSync('git', ['config', 'user.name', 'Telemetry Test'], { cwd: PROJ });
fs.mkdirSync(path.join(PROJ, 'lib'));
fs.writeFileSync(path.join(PROJ, 'lib', 'tracked.js'), 'module.exports = 1;\n');
execFileSync('git', ['add', '.'], { cwd: PROJ });
execFileSync('git', ['commit', '--quiet', '-m', 'add tracked fixture'], { cwd: PROJ });

const mcp = require('../lib/mcp.js') as { handleRequest(request: UnknownRecord): Promise<unknown> };
const BIN = path.join(__dirname, '..', 'bin', 'sidequest.js');
const { runCli, cliJson } = makeCliRunner(BIN, { SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: PROJ });
const { callTool } = makeMcpCaller(mcp);
let ref: string;

test('seed telemetry fixture', () => {
  const ticket = cliJson<{ ticket: { ref: string } }>(['add', '-t', 'telemetry fixture', '--file', 'lib/tracked.js', '--complexity', '3', '--why', 'a routine tracked-file fixture for telemetry-read coverage', '--label', 'direct-ok', '--json']);
  ref = ticket.ticket.ref;
  assert.strictEqual(runCli(['claim', ref, '--by', 'telemetry-worker', '--direct', '--reason', 'The telemetry fixture requires a local direct claim.']).status, 0);
  assert.strictEqual(runCli(['comment', ref, '--by', 'telemetry-worker', '-m', 'a recent telemetry note']).status, 0);
});

test('CLI and MCP pulse return the compact liveness shape with git activity', async () => {
  const pulse = cliJson<Pulse>(['pulse', ref]);
  assert.deepStrictEqual(Object.keys(pulse).sort(), ['checkpoint', 'claim', 'comments', 'direct', 'dispatch', 'dispatchExecutor', 'git', 'lastActivityAt', 'lastComment', 'project', 'projectName', 'ref', 'status', 'submission', 'title', 'working']);
  assert.deepStrictEqual(Object.keys(pulse.claim).sort(), ['ageMs', 'at', 'by']);
  assert.strictEqual(pulse.comments, 1);
  assert.deepStrictEqual(pulse.lastComment, { at: pulse.lastComment.at, by: 'telemetry-worker', kind: 'comment', body: 'a recent telemetry note' });
  assert.match(pulse.git.commit.hash, /^[0-9a-f]{40}$/);
  assert.strictEqual(pulse.git.dirty, false);
  const viaMcp = await callTool<Pulse>('pulse', { ref, full: true });
  assert.strictEqual(viaMcp.ref, ref);
  assert.strictEqual(viaMcp.git.commit.hash, pulse.git.commit.hash);
});

test('changes returns an ordered compact delta and reusable serverTime', async () => {
  const before = new Date(Date.now() - 1000).toISOString();
  assert.strictEqual(runCli(['comment', ref, '--by', 'telemetry-worker', '-m', 'a second telemetry note']).status, 0);
  const changes = cliJson<Changes>(['changes', '--since', before]);
  assert.deepStrictEqual(Object.keys(changes).sort(), ['project', 'projectName', 'serverTime', 'since', 'tickets']);
  const changed = changes.tickets.find((ticket) => ticket.ref === ref);
  assert.ok(changed);
  assert.deepStrictEqual(Object.keys(changed).sort(), ['checkpoint', 'claim', 'lastComment', 'lastEventSource', 'lastEventType', 'ref', 'status', 'title', 'updatedAt']);
  assert.deepStrictEqual(changed.lastComment, {
    by: 'telemetry-worker',
    kind: 'comment',
    body: 'a second telemetry note',
    bodyLength: 23,
    bodyTruncated: false,
  });
  assert.strictEqual(changed.lastEventType, 'comment');
  assert.strictEqual(changed.lastEventSource, 'cli');
  assert.ok(Date.parse(changes.serverTime) >= Date.parse(changed.updatedAt));
  const viaMcp = await callTool<Changes>('changes', { since: before });
  assert.ok(viaMcp.tickets.some((ticket) => ticket.ref === ref));
});

test('pulse git probe reports scoped working tree changes', () => {
  fs.writeFileSync(path.join(PROJ, 'lib', 'tracked.js'), 'module.exports = 2;\n');
  const pulse = cliJson<Pulse>(['pulse', ref]);
  assert.strictEqual(pulse.git.dirty, true);
});

test('native lifecycle observations include only allowlisted metadata', () => {
  const telemetry = require('../lib/telemetry.js') as {
    ticketObservation(project: unknown, ticket: unknown): TicketObservation | null;
  };
  const ticket = {
    ref: 'SQ-42',
    title: 'do not emit this title',
    description: 'or this description',
    status: 'doing',
    categoryId: 'coding.normal',
    category: { route: { model: 'terra', effort: 'high' } },
    model: 'gpt-5.6-terra',
    effort: 'high',
    exec: { agent: 'sidequest-exec-dispatch-high', backend: 'codex' },
    claim: { by: 'worker-1' },
    dispatch: {
      id: 'dispatch-42',
      sessionId: 'session-42',
      taskId: 'task-42',
      agentId: 'agent-42',
      executor: 'sidequest-exec-dispatch-high',
      tokenPrefix: 'must-not-leak',
    },
    updatedAt: '2026-07-19T10:00:00.000Z',
  };
  const project = { slug: 'project-42', path: 'C:\\workspace\\canonical-project' };
  const observation = telemetry.ticketObservation(project, ticket) as TicketObservation;
  const projectId = crypto.createHash('sha256').update(project.path).digest('hex');
  assert.deepStrictEqual(observation.attributes, {
    category: 'coding.normal',
    configured_model: 'terra',
    configured_effort: 'high',
    configured_backend: 'codex',
    resolved_model: 'gpt-5.6-terra',
    resolved_effort: 'high',
    resolved_backend: 'codex',
    executor: 'sidequest-exec-dispatch-high',
    dispatch_id: 'dispatch-42',
    claim_worker_id: 'worker-1',
    claim_session_id: 'session-42',
    task_status: 'doing',
  });
  assert.strictEqual(observation.project_id, projectId);
  assert.strictEqual(observation.task_id, 'task-42');
  assert.strictEqual(observation.route_id, 'dispatch-42');
  assert.strictEqual(observation.session_id, 'session-42');
  assert.strictEqual(observation.agent_id, 'agent-42');
  assert.match(observation.source_event_id, /^sidequest_[a-f0-9]{64}$/);
  assert.strictEqual(telemetry.ticketObservation(project, ticket)!.source_event_id, observation.source_event_id);
  assert.strictEqual(telemetry.ticketObservation(project, Object.assign({}, ticket, { submission: { commit: 'abc1234' } }))!.attributes.task_status, 'submitted');
  const serialized = JSON.stringify(observation);
  for (const secret of ['do not emit this title', 'or this description', 'must-not-leak', project.path]) assert.ok(!serialized.includes(secret));
});

test('shared store boundary emits once for MCP mutations', async () => {
  const telemetry = require('../lib/telemetry.js') as {
    setTestSink(sink: ((observation: TicketObservation) => void) | null): void;
  };
  const observed: TicketObservation[] = [];
  telemetry.setTestSink((observation) => observed.push(observation));
  try {
    const result = await callTool<{ ok: boolean }>('update', { ref, status: 'todo' });
    assert.strictEqual(result.ok, true);
  } finally {
    telemetry.setTestSink(null);
  }
  assert.strictEqual(observed.length, 1);
  assert.strictEqual(observed[0]?.ticket_ref, ref);
  assert.strictEqual(observed[0]?.attributes.task_status, 'todo');
});
