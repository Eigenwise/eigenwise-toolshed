import './_temp-cleanup.js';
import './_sidequest-install-fixture.js';
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
const CONTROL_MULTIPLIERS = {
  sessionStart: { median: 10, p95: 15 },
  guard: { median: 1.75, p95: 3 },
  // guard-destructive-git shells out to git to classify the command, so it costs
  // more than the pure-parse guards. It runs on every Bash call; if this ceiling
  // ever needs raising again, make the hook cheaper instead.
  gitGuard: { median: 3.5, p95: 5 },
  guardsSerial: { median: 6, p95: 8 },
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
assert.equal(db.countRows(database, 'tickets'), 1870);


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

function assertBudget(name: string, measured: { median: number; p95: number; control: { median: number; p95: number } }, ceiling: { median: number; p95: number }): void {
  assert.ok(measured.median <= measured.control.median * ceiling.median, `${name} median ${measured.median.toFixed(1)}ms exceeds ${ceiling.median}x its ${measured.control.median.toFixed(1)}ms process-start control`);
  assert.ok(measured.p95 <= measured.control.p95 * ceiling.p95, `${name} p95 ${measured.p95.toFixed(1)}ms exceeds ${ceiling.p95}x its ${measured.control.p95.toFixed(1)}ms process-start control`);
}

test('fresh-process hook latency stays inside release ceilings', (context: any) => {
  const bashPayload = { tool_name: 'Bash', session_id: 'perf-guard', tool_input: { command: 'git status' } };
  const sessionStart = measure(() => runHook('session-start.js', { session_id: 'perf-session', cwd: projectPaths[0] }));
  const homeDelete = measure(() => runHook('guard-home-delete.js', bashPayload));
  const repeatedCommand = measure(() => runHook('repeated-command-warn.js', bashPayload));
  const destructiveGit = measure(() => runHook('guard-destructive-git.js', bashPayload));
  const guardsSerial = measure(() => {
    runHook('guard-home-delete.js', bashPayload);
    runHook('repeated-command-warn.js', bashPayload);
    runHook('guard-destructive-git.js', bashPayload);
  });

  for (const [name, measured, ceiling] of [
    ['SessionStart', sessionStart, CONTROL_MULTIPLIERS.sessionStart],
    ['guard-home-delete', homeDelete, CONTROL_MULTIPLIERS.guard],
    ['repeated-command-warn', repeatedCommand, CONTROL_MULTIPLIERS.guard],
    ['guard-destructive-git', destructiveGit, CONTROL_MULTIPLIERS.gitGuard],
    ['common guards serial', guardsSerial, CONTROL_MULTIPLIERS.guardsSerial],
  ] as const) {
    assertBudget(name, measured, ceiling);
    context.diagnostic(`${name}: ${measured.median.toFixed(1)}ms median, ${measured.p95.toFixed(1)}ms p95; control ${measured.control.median.toFixed(1)}ms median, ${measured.control.p95.toFixed(1)}ms p95`);
  }
});
