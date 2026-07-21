'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const RUNS = 20;
const WARMUPS = 3;
const CONTROL_MULTIPLIERS = {
  sessionStart: { median: 10, p95: 15 },
  boardFirst: { median: 3, p95: 4 },
  subagentStart: { median: 8, p95: 12 },
  subagentStop: { median: 8, p95: 12 },
  guard: { median: 1.75, p95: 3 },
  guardsSerial: { median: 3, p95: 3 },
};

const pluginRoot = path.join(__dirname, '..');
const hooksRoot = path.join(pluginRoot, 'hooks');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-hooks-perf-home-'));
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-hooks-perf-projects-'));
const projectPaths = Array.from({ length: 12 }, (_, index: number) => path.join(fixtureRoot, `project-${index + 1}`));
for (const projectPath of projectPaths) fs.mkdirSync(projectPath, { recursive: true });
process.env.SIDEQUEST_HOME = home;
process.env.CLAUDE_PROJECT_DIR = projectPaths[0];
process.env.SIDEQUEST_AGENTS_DIR = path.join(home, 'agents');

const store = require('../lib/store.js');
const db = require('../lib/db.js');
const slugs = projectPaths.map((projectPath: string) => store.ensureProject(projectPath).slug);
store.setCategory({
  id: 'perf.fixture',
  name: 'Performance fixture',
  description: 'Fixed hook performance fixture.',
  route: { model: 'sonnet', effort: 'high' },
  fallback: null,
  enabled: true,
});
const startTicket = store.createTicket(slugs[0], { title: 'Subagent start fixture', category: 'perf.fixture', source: 'test' });
const stopTicket = store.createTicket(slugs[0], { title: 'Subagent stop fixture', category: 'perf.fixture', source: 'test' });
const database = db.openDb(home);
let backgroundId = 0;
db.txn(database, () => {
  for (let projectIndex = 0; projectIndex < slugs.length; projectIndex += 1) {
    const count = projectIndex === 0 ? 154 : 156;
    for (let index = 0; index < count; index += 1) {
      backgroundId += 1;
      const id = `perf-${backgroundId}`;
      const ref = `SQ-${10000 + backgroundId}`;
      const ticket = {
        id,
        ref,
        project: slugs[projectIndex],
        title: `Performance ticket ${backgroundId}`,
        description: 'Fixed hook performance fixture.',
        category: 'perf.fixture',
        status: 'todo',
        archived: false,
        order: index,
        files: [],
        comments: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      db.putRow(database, 'tickets', {
        id,
        project: slugs[projectIndex],
        ref,
        status: 'todo',
        archived: 0,
        ord: index,
        claim_by: null,
        data: ticket,
      });
    }
  }
});
assert.equal(db.countRows(database, 'tickets'), 1872);

const startSession = 'perf-subagent-start';
const startDispatch = store.prepareDispatch(slugs[0], startTicket.ref, { sessionId: startSession });
store.recordDispatchLaunch(slugs[0], startTicket.ref, {
  token: startDispatch.token,
  executor: startDispatch.ticket.dispatchExecutor,
  sessionId: startSession,
  agentName: 'perf-start-agent',
});
const stopSession = 'perf-subagent-stop';
const stopDispatch = store.prepareDispatch(slugs[0], stopTicket.ref, { sessionId: stopSession });
store.recordDispatchLaunch(slugs[0], stopTicket.ref, {
  token: stopDispatch.token,
  executor: stopDispatch.ticket.dispatchExecutor,
  sessionId: stopSession,
  agentName: 'perf-stop-agent',
});
store.bindDispatchAgent(stopSession, stopDispatch.ticket.dispatchExecutor, 'perf-stop-id', 'perf-stop-agent');
store.claimTicket(slugs[0], stopTicket.ref, 'perf-worker', {
  sessionId: stopSession,
  token: stopDispatch.token,
  executor: stopDispatch.ticket.dispatchExecutor,
});

const env = {
  ...process.env,
  SIDEQUEST_HOME: home,
  CLAUDE_PROJECT_DIR: projectPaths[0],
  CLAUDE_PLUGIN_ROOT: pluginRoot,
  SIDEQUEST_AGENTS_DIR: path.join(home, 'agents'),
};

function runProcess(args: string[], payload: unknown): void {
  const result = spawnSync(process.execPath, args, {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env,
  });
  assert.equal(result.status, 0, `${args[0]}: ${result.stderr}`);
}

function runHook(script: string, payload: unknown): void {
  runProcess([path.join(hooksRoot, script)], payload);
}

function runControl(): void {
  runProcess(['-e', ''], {});
}

function percentile(samples: number[], fraction: number): number {
  const sorted = samples.slice().sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] || 0;
}

function measure(run: (index: number) => void): { median: number; p95: number; control: { median: number; p95: number } } {
  for (let index = -WARMUPS; index < 0; index += 1) {
    runControl();
    run(index);
  }
  const samples: number[] = [];
  const controls: number[] = [];
  for (let index = 0; index < RUNS; index += 1) {
    const controlStarted = performance.now();
    runControl();
    controls.push(performance.now() - controlStarted);
    const started = performance.now();
    run(index);
    samples.push(performance.now() - started);
  }
  return {
    median: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    control: { median: percentile(controls, 0.5), p95: percentile(controls, 0.95) },
  };
}

function assertBudget(name: string, measured: { median: number; p95: number; control: { median: number; p95: number } }, ceiling: { median: number; p95: number }): void {
  assert.ok(measured.median <= measured.control.median * ceiling.median, `${name} median ${measured.median.toFixed(1)}ms exceeds ${ceiling.median}x its ${measured.control.median.toFixed(1)}ms process-start control`);
  assert.ok(measured.p95 <= measured.control.p95 * ceiling.p95, `${name} p95 ${measured.p95.toFixed(1)}ms exceeds ${ceiling.p95}x its ${measured.control.p95.toFixed(1)}ms process-start control`);
}

test('fresh-process hook latency stays inside release ceilings', (context: any) => {
  const sessionStart = measure(() => runHook('session-start.js', { session_id: 'perf-session', cwd: projectPaths[0] }));
  const boardFirst = measure((index) => runHook('board-first-reminder.js', {
    session_id: `perf-board-${index}`,
    cwd: projectPaths[0],
    prompt: 'Implement the fixture ticket.',
  }));
  const subagentStart = measure(() => runHook('subagent-start.js', {
    session_id: startSession,
    agent_type: startDispatch.ticket.dispatchExecutor,
    agent_id: 'perf-start-id',
    agent_name: 'perf-start-agent',
  }));
  const subagentStop = measure(() => runHook('subagent-stop.js', {
    session_id: stopSession,
    agent_type: stopDispatch.ticket.dispatchExecutor,
    agent_id: 'perf-stop-id',
    agent_name: 'perf-stop-agent',
  }));
  const nearTurnCap = measure(() => runHook('near-turn-cap.js', { tool_name: 'Read', session_id: 'perf-guard' }));
  const inlineWork = measure(() => runHook('inline-work-nudge.js', {
    tool_name: 'Read',
    session_id: 'perf-guard',
    agent_id: 'executor',
  }));
  const guardsSerial = measure(() => {
    runHook('near-turn-cap.js', { tool_name: 'Read', session_id: 'perf-guard' });
    runHook('inline-work-nudge.js', { tool_name: 'Read', session_id: 'perf-guard', agent_id: 'executor' });
  });

  for (const [name, measured, ceiling] of [
    ['SessionStart', sessionStart, CONTROL_MULTIPLIERS.sessionStart],
    ['board-first', boardFirst, CONTROL_MULTIPLIERS.boardFirst],
    ['SubagentStart', subagentStart, CONTROL_MULTIPLIERS.subagentStart],
    ['SubagentStop', subagentStop, CONTROL_MULTIPLIERS.subagentStop],
    ['near-turn-cap', nearTurnCap, CONTROL_MULTIPLIERS.guard],
    ['inline-work-nudge', inlineWork, CONTROL_MULTIPLIERS.guard],
    ['common guards serial', guardsSerial, CONTROL_MULTIPLIERS.guardsSerial],
  ] as const) {
    assertBudget(name, measured, ceiling);
    context.diagnostic(`${name}: ${measured.median.toFixed(1)}ms median, ${measured.p95.toFixed(1)}ms p95; control ${measured.control.median.toFixed(1)}ms median, ${measured.control.p95.toFixed(1)}ms p95`);
  }
});
