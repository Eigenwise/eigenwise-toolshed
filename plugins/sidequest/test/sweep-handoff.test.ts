import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { runSweep, reportFile, drainReport, writeReport, readSessionEndHandoff } from '../src/hooks/shared/sweep-handoff.js';
import { acquireSweepFlight, protectSweepFlight, reclaimSweepFlight, releaseSweepFlight } from '../src/hooks/shared/sweep-flight.js';

const plugin = path.resolve(__dirname, '..');
const { isProcessTerminal } = require('../scripts/owned-process-tree.js') as { isProcessTerminal(pid: number): boolean };

async function waitUntil(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!check() && Date.now() < deadline) await delay(25);
  assert.ok(check(), 'owned sweep settles within the test deadline');
}

test('overlapping SessionStart handoffs start one sweep and the worker deadline ends its descendants', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-sweep-flight-'));
  const marker = path.join(home, 'workers.jsonl');
  const preload = path.join(home, 'stall-maintenance.cjs');
  const environment = { ...process.env };
  fs.writeFileSync(preload, `
const Module = require('node:module');
const load = Module._load;
Module._load = function(request, parent, isMain) {
  if (request.endsWith('/lib/store.js') || request.endsWith('\\\\lib\\\\store.js')) {
    const descendant = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    require('node:fs').appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ worker: process.pid, descendant: descendant.pid }) + '\\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000);
  }
  return load.call(this, request, parent, isMain);
};
`);
  Object.assign(process.env, {
    SIDEQUEST_HOME: home,
    CLAUDE_PLUGIN_ROOT: plugin,
    SIDEQUEST_SWEEP_DEADLINE_MS: '0',
    SIDEQUEST_SWEEP_WORKER_DEADLINE_MS: '3000',
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require "${preload.replaceAll(path.sep, '/')}"`,
  });
  try {
    const notices = await Promise.all([runSweep({ cwd: home }), runSweep({ cwd: home })]);
    for (const result of notices) assert.match(result.join('\n'), /still running in the background/);
    await waitUntil(() => fs.existsSync(marker));
    const workers = fs.readFileSync(marker, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { worker: number; descendant: number });
    assert.equal(workers.length, 1, 'overlapping SessionStart invocations start one maintenance worker');
    assert.ok(workers[0]);
    await delay(3500);
    assert.ok(isProcessTerminal(workers[0].worker), 'deadline cleanup ends the worker');
    assert.ok(isProcessTerminal(workers[0].descendant), 'deadline cleanup ends the owned descendant');
    assert.match((drainReport(home) || []).join('\n'), /worker deadline/);
  } finally {
    await waitUntil(() => !fs.existsSync(reportFile(home).replace(/\.json$/, '.flight')));
    process.env = environment;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('dead sweep ownership is reclaimed without letting an old token release its successor', () => {
  const environment = { ...process.env };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-sweep-reclaim-'));
  process.env.SIDEQUEST_HOME = home;
  try {
    const flight = acquireSweepFlight(home)!;
    assert.equal(acquireSweepFlight(home), null, 'a live sweep retains single-flight ownership');
    flight.transfer(99999999);
    reclaimSweepFlight(home);
    const successor = acquireSweepFlight(home)!;
    releaseSweepFlight(home, flight.token);
    reclaimSweepFlight(home);
    assert.equal(acquireSweepFlight(home), null, 'stale release cannot remove a live successor');
    successor.release();
    assert.ok(acquireSweepFlight(home));
  } finally {
    process.env = environment;
    fs.rmSync(home, { recursive: true, force: true });
  }
});


test('a start that finds a live sweep still collects the report that sweep already wrote', async () => {
  const environment = { ...process.env };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-sweep-held-'));
  process.env.SIDEQUEST_HOME = home;
  try {
    const flight = acquireSweepFlight(home)!;
    assert.match((await runSweep({ cwd: home })).join('\n'), /still running in the background/);
    writeReport(home, ['sidequest: live sweep notice']);
    assert.deepEqual(await runSweep({ cwd: home }), ['sidequest: live sweep notice']);
    assert.equal(drainReport(home), null, 'a collected report is not replayed into the next start');
    fs.writeFileSync(reportFile(home).replace(/\.json$/, '.flight'), `99999999:${flight.token}:0`);
    writeReport(home, ['sidequest: notice before cleanup failed']);
    const paused = (await runSweep({ cwd: home })).join('\n');
    assert.match(paused, /notice before cleanup failed/);
    assert.match(paused, /Automatic sweeps remain paused/);
    releaseSweepFlight(home, flight.token);
  } finally {
    process.env = environment;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('native sweep ownership survives the handoff supervisor and unknown cleanup stays protected', () => {
  const environment = { ...process.env };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-sweep-owner-'));
  process.env.SIDEQUEST_HOME = home;
  try {
    const flight = acquireSweepFlight(home)!;
    protectSweepFlight(home, flight.token, process.pid);
    const file = reportFile(home).replace(/\.json$/, '.flight');
    fs.writeFileSync(file, `99999999:${flight.token}:${process.pid}`);
    reclaimSweepFlight(home);
    assert.equal(acquireSweepFlight(home), null, 'a live native owner prevents reclamation after supervisor death');
    fs.writeFileSync(file, `99999999:${flight.token}:0`);
    reclaimSweepFlight(home);
    assert.equal(acquireSweepFlight(home), null, 'unknown cleanup cannot be reclaimed as a dead sweep');
    fs.writeFileSync(file, `99999999:${flight.token}:99999998`);
    reclaimSweepFlight(home);
    const successor = acquireSweepFlight(home)!;
    assert.ok(successor, 'terminal native ownership permits safe reclamation');
    successor.release();
  } finally {
    process.env = environment;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('failed owned cleanup keeps the flight protected instead of starting a successor', async () => {
  const environment = { ...process.env };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-sweep-failure-'));
  const preload = path.join(home, 'failed-owned-cleanup.cjs');
  fs.writeFileSync(preload, `
const Module = require('node:module');
const load = Module._load;
Module._load = function(request, parent, isMain) {
  if (request.endsWith('owned-process-tree.js')) return { runOwnedPhase: async () => ({ timedOut: true, cleanupError: 'owned cleanup unconfirmed', status: null }) };
  return load.call(this, request, parent, isMain);
};
`);
  Object.assign(process.env, {
    SIDEQUEST_HOME: home,
    CLAUDE_PLUGIN_ROOT: plugin,
    SIDEQUEST_SWEEP_DEADLINE_MS: '5000',
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require "${preload.replaceAll(path.sep, '/')}"`,
  });
  try {
    const notices = await runSweep({ cwd: home });
    assert.match(notices.join('\n'), /owned cleanup unconfirmed/);
    reclaimSweepFlight(home);
    assert.equal(acquireSweepFlight(home), null, 'cleanup failure retains single-flight ownership');
  } finally {
    process.env = environment;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

function projectGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

// Old trees whose commits are already on main, so any sweep that reaches them reclaims them.
function boardWithReclaimableTrees(home: string, count: number): { project: string; trees: string[] } {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-session-end-board-'));
  projectGit(project, ['init', '-b', 'main']);
  projectGit(project, ['config', 'user.name', 'Sidequest Test']);
  projectGit(project, ['config', 'user.email', 'sidequest-test@example.invalid']);
  fs.writeFileSync(path.join(project, 'README.md'), 'session-end fixture\n');
  projectGit(project, ['add', '.']);
  projectGit(project, ['commit', '-m', 'base']);
  const old = new Date(Date.now() - 4 * 60 * 60 * 1000);
  const trees = Array.from({ length: count }, (_, index) => {
    const tree = path.join(project, '.claude', 'worktrees', `agent-session-end-${index}`);
    projectGit(project, ['worktree', 'add', '-b', `worktree-agent-session-end-${index}`, tree, 'main']);
    fs.writeFileSync(path.join(tree, `integrated-${index}.txt`), 'integrated\n');
    projectGit(tree, ['add', '.']);
    projectGit(tree, ['commit', '-m', `integrated ${index}`]);
    projectGit(project, ['cherry-pick', projectGit(tree, ['rev-parse', 'HEAD'])]);
    fs.utimesSync(tree, old, old);
    return tree;
  });
  execFileSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(plugin, 'lib', 'store.js'))}).ensureProject(${JSON.stringify(project)})`], {
    env: { ...process.env, SIDEQUEST_HOME: home }, windowsHide: true,
  });
  return { project, trees };
}

function stubPluginRoot(marker: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-session-end-stub-'));
  fs.symlinkSync(path.join(plugin, 'lib'), path.join(root, 'lib'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.mkdirSync(path.join(root, 'hooks'));
  fs.writeFileSync(path.join(root, 'hooks', 'sweep-worktrees.js'), `require('fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));\n`);
  return root;
}

function sweepSessions(home: string): Record<string, string> {
  return (JSON.parse(fs.readFileSync(path.join(home, 'worktree-sweep-sessions.json'), 'utf8')) as { sessions?: Record<string, string> }).sessions || {};
}

// GH-400: Claude Code gives SessionEnd about 1.5 s whatever its timeout says. A sweep it started over
// more trees than fit was cancelled mid-write, and the cancelled worker never unregistered its session,
// so the ended session's tree read as live from then on. SessionEnd now only marks and hands off.
test('SessionEnd finishes under the exit budget, starts no sweep, and hands the trees to SessionStart maintenance', async () => {
  const environment = { ...process.env };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-session-end-home-'));
  const marker = path.join(home, 'sweep-worker-started.json');
  const stubRoot = stubPluginRoot(marker);
  const { project, trees } = boardWithReclaimableTrees(home, 3);
  fs.writeFileSync(path.join(home, 'worktree-sweep-sessions.json'), JSON.stringify({ sessions: { 'ended-session': project, 'other-session': home } }));
  const spawnBaselineMs = (() => {
    const started = Date.now();
    execFileSync(process.execPath, ['-e', ''], { windowsHide: true });
    return Math.max(1, Date.now() - started);
  })();
  try {
    const started = Date.now();
    const ended = spawnSync(process.execPath, [path.join(plugin, 'hooks', 'session-end.js')], {
      input: JSON.stringify({ session_id: 'ended-session', cwd: project, reason: 'prompt_input_exit' }),
      encoding: 'utf8',
      env: { ...process.env, SIDEQUEST_HOME: home, CLAUDE_PLUGIN_ROOT: stubRoot },
      windowsHide: true,
    });
    const elapsedMs = Date.now() - started;

    assert.equal(ended.status, 0, ended.stderr);
    assert.ok(elapsedMs < Math.max(1500, spawnBaselineMs * 10), `session-end took ${elapsedMs}ms`);
    assert.deepEqual(Object.keys(sweepSessions(home)), ['other-session'], 'the ended session is unregistered before the hook returns, so nothing can strand it');
    const handoff = readHandoffAs(home, project);
    assert.deepEqual(handoff?.sessions, ['ended-session'], 'the owed sweep is recorded for the next maintenance run');
    await delay(Math.max(2000, spawnBaselineMs * 20));
    assert.equal(fs.existsSync(marker), false, 'no sweep worker was started from SessionEnd');
    for (const tree of trees) assert.equal(fs.existsSync(tree), true, 'SessionEnd itself touches no tree');

    Object.assign(process.env, { SIDEQUEST_HOME: home, CLAUDE_PLUGIN_ROOT: plugin, SIDEQUEST_SWEEP_DEADLINE_MS: '60000' });
    const notices = await runSweep({ cwd: project, session_id: 'next-session' });

    assert.doesNotMatch(notices.join('\n'), /could not run|failed/, notices.join('\n'));
    for (const tree of trees) assert.equal(fs.existsSync(tree), false, `SessionStart maintenance reclaimed ${tree}`);
    assert.equal(readHandoffAs(home, project), null, 'the maintenance run that swept the project clears the handoff');
  } finally {
    process.env = environment;
    fs.rmSync(stubRoot, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function readHandoffAs(home: string, project: string) {
  const previous = process.env.SIDEQUEST_HOME;
  process.env.SIDEQUEST_HOME = home;
  try {
    return readSessionEndHandoff(project);
  } finally {
    process.env.SIDEQUEST_HOME = previous;
  }
}

test('SessionEnd stays fail-soft without a plugin runtime and still unregisters the session', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-session-end-soft-'));
  fs.writeFileSync(path.join(home, 'worktree-sweep-sessions.json'), JSON.stringify({ sessions: { 'soft-session': home } }));
  try {
    const ended = spawnSync(process.execPath, [path.join(plugin, 'hooks', 'session-end.js')], {
      input: JSON.stringify({ session_id: 'soft-session', cwd: home }),
      encoding: 'utf8',
      env: { ...process.env, SIDEQUEST_HOME: home, CLAUDE_PLUGIN_ROOT: path.join(home, 'missing-plugin') },
      windowsHide: true,
    });
    assert.equal(ended.status, 0, ended.stderr);
    assert.match(ended.stderr, /session-end reconciliation failed/);
    assert.deepEqual(sweepSessions(home), {});
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('equivalent Windows project spellings share the same sweep flight', { skip: process.platform !== 'win32' }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-sweep-path-'));
  try {
    assert.equal(reportFile(home), reportFile(home.toUpperCase().replaceAll('\\', '/')));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
