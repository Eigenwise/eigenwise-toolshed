import './_temp-cleanup.js';
import './_sidequest-install-fixture.js';
import './_hook-runtime.js';
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
const PROCESS_SAMPLE_TIMEOUT_MS = 5_000;

const pluginRoot = path.join(__dirname, '..');
const hooksRoot = path.join(pluginRoot, 'hooks');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-hooks-perf-home-'));
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-hooks-perf-projects-'));
const discoveryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-hooks-perf-discovery-'));
const catalogPath = path.join(discoveryRoot, 'model-gateway', 'catalog.json');
// Sized to a real board rather than a token one: the live store this fixture stands in for carried
// 28 projects and 5190 tickets, where the unnarrowed SubagentStop scan cost 2.0s of the 5000ms the
// host hardcodes for that hook on its interrupted-query path. At 12 projects it stayed invisible.
const projectPaths = Array.from({ length: 25 }, (_, index: number) => path.join(fixtureRoot, `project-${index + 1}`));
for (const projectPath of projectPaths) fs.mkdirSync(projectPath, { recursive: true });

function writeDiscoveryCatalog(generation: string): void {
  fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
  fs.writeFileSync(catalogPath, JSON.stringify({
    schemaVersion: 4,
    updatedAt: new Date().toISOString(),
    providers: { codex: { ready: true, state: 'ready', message: 'Codex is ready.' } },
    models: [{ slug: 'codex-gpt-perf', id: 'claude-gpt-perf', label: 'GPT Perf', provider: 'codex' }],
    generation,
  }));
}

writeDiscoveryCatalog('initial');
process.env.SIDEQUEST_DISCOVERY_DIRS = discoveryRoot;
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
const startTicket = store.createTicket(slugs[0], {
  title: 'Subagent start fixture', category: 'perf.fixture', files: ['fixture.txt'], source: 'test',
});
const stopTicket = store.createTicket(slugs[0], {
  title: 'Subagent stop fixture', category: 'perf.fixture', files: ['fixture.txt'], source: 'test',
});
// Parse cost tracks bytes, not row count: the live store this fixture stands in for held 103 MiB
// over 5190 tickets, a mean of 19.9 KiB each. Seeding ~400-byte rows made a full-board scan look 50x
// cheaper than it is, which is the other half of why SubagentStop's budget stayed invisible.
const ticketBody = 'Fixed hook performance fixture. '.repeat(620);
const database = db.openDb(home);
let backgroundId = 0;
db.txn(database, () => {
  for (let projectIndex = 0; projectIndex < slugs.length; projectIndex += 1) {
    const count = projectIndex === 0 ? 198 : 200;
    for (let index = 0; index < count; index += 1) {
      backgroundId += 1;
      const id = `perf-${backgroundId}`;
      const ref = `SQ-${10000 + backgroundId}`;
      const ticket = {
        id,
        ref,
        project: slugs[projectIndex],
        title: `Performance ticket ${backgroundId}`,
        description: ticketBody,
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
assert.equal(db.countRows(database, 'tickets'), 5000);

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
    timeout: PROCESS_SAMPLE_TIMEOUT_MS,
  });
  assert.equal(result.status, 0, `${args[0]}: ${result.error?.message ?? result.stderr}`);
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

test('a full sweep across seeded projects reads the catalog a bounded number of times', () => {
  writeDiscoveryCatalog('catalog-state-after-store-startup');
  let catalogReads = 0;
  const originalReadFileSync = fs.readFileSync;
  Object.defineProperty(fs, 'readFileSync', {
    configurable: true,
    value(...arguments_: unknown[]) {
      const [file] = arguments_;
      if (typeof file === 'string' && path.resolve(file) === catalogPath) catalogReads += 1;
      return Reflect.apply(originalReadFileSync, fs, arguments_);
    },
  });
  try {
    store.sweepStaleClaims({ source: 'test' });
    assert.ok(catalogReads <= 4, `expected at most four catalog reads, received ${catalogReads}`);
  } finally {
    Object.defineProperty(fs, 'readFileSync', { configurable: true, value: originalReadFileSync });
  }
});

test('fresh-process hook latency reports benchmark measurements', (context: any) => {
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
  const inlineWork = measure(() => runHook('inline-work-nudge.js', {
    tool_name: 'Read',
    session_id: 'perf-guard',
    agent_id: 'executor',
  }));
  const guardsSerial = measure(() => {
    runHook('inline-work-nudge.js', { tool_name: 'Read', session_id: 'perf-guard', agent_id: 'executor' });
  });

  for (const [name, measured] of [
    ['SessionStart', sessionStart],
    ['board-first', boardFirst],
    ['SubagentStart', subagentStart],
    ['SubagentStop', subagentStop],
    ['inline-work-nudge', inlineWork],
    ['common guards serial', guardsSerial],
  ] as const) {
    context.diagnostic(`${name}: ${measured.median.toFixed(1)}ms median, ${measured.p95.toFixed(1)}ms p95; control ${measured.control.median.toFixed(1)}ms median, ${measured.control.p95.toFixed(1)}ms p95`);
  }

  // The only hook whose budget the host hardcodes: runAgent's interrupted-query fallback gives
  // SubagentStop 5000ms instead of the usual 600000ms, and a launched attempt that misses it waits
  // out the claim grace instead. A diagnostic line alone kept that invisible (SQ-2864).
  assert.ok(
    subagentStop.p95 < 1500,
    `SubagentStop fresh-process p95 ${subagentStop.p95.toFixed(1)}ms exceeds the 1500ms bound inside the host's 5000ms failure-path wait`,
  );
  // The absolute bound alone does not discriminate: the whole-board scan this replaced measures
  // 837.8ms p95 on this fixture, which still fits 1500ms. What must not come back is a cost that
  // grows with the board, so bound the work ABOVE a bare `node -e ''` instead, which also keeps this
  // honest on a slow runner where node's own start dominates. Measured here: 175.4ms with the
  // narrowed query against 786.4ms without it, so 400ms sits 2.3x over the cost and 2.0x under the
  // regression. The narrowed cost holds as the board grows; the scan's does not.
  const subagentStopWork = subagentStop.p95 - subagentStop.control.p95;
  assert.ok(
    subagentStopWork < 400,
    `SubagentStop spends ${subagentStopWork.toFixed(1)}ms above bare node start; a whole-board scan is back`,
  );
});
