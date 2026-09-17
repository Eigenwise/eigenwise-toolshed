import './_temp-cleanup.js';
import './_sidequest-install-fixture.js';
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn, spawnSync } = require('node:child_process');

const { runVerifyCapture, runCapturedVerification, runFullSuiteVerification, shellCommand, captureSlotDirectory, recordCapture } = require('../lib/verify-capture.js');
const { runProcessVerification } = require('../lib/ports/process.js');
const store = require('../lib/store.js');
const worktrees = require('../lib/worktrees.js');
const worktreeLease = require('../lib/kernel/worktree.js');
const SIDEQUEST_DIR = path.resolve(__dirname, '..');

// SQ-10: zsh (unlike sh/bash) glob-expands an unquoted path, and with `nomatch` set (its
// default) aborts the whole verify command with "no matches found" when nothing matches a
// pattern like `[fulfillmentId]`. Force SHELL=zsh when it's actually on the box so this test
// exercises the real regression; on a host without zsh (Windows CI) there is no `SHELL`-based
// POSIX shell selection to force at all, so the case is skipped rather than faked.
function locateZsh(): string | null {
  if (process.platform === 'win32') return null;
  const found = spawnSync('which', ['zsh'], { encoding: 'utf8' });
  const candidate = String(found.stdout || '').trim().split(/\r?\n/)[0];
  return found.status === 0 && candidate && fs.existsSync(candidate) ? candidate : null;
}
const ZSH_EXECUTABLE = locateZsh();
const UNQUOTED_GLOB_SHELL = ZSH_EXECUTABLE || (process.platform === 'win32' ? null : '/bin/sh');

function deleteLog(capture: { logPath: string }) {
  fs.rmSync(capture.logPath, { force: true });
}

function nodeCommand(scriptPath: string, argument: string) {
  return `"${process.execPath}" "${scriptPath}" "${argument}"`;
}

function runCaptureProcess(command: string, project: string, ticket: string, options: { worktree?: string; cwd?: string } = {}): Promise<Readonly<{ status: number | null; output: string }>> {
  return new Promise((resolve, reject) => {
    const args = [path.join(SIDEQUEST_DIR, 'lib', 'verify-capture.js'), '--base64', Buffer.from(command).toString('base64'), '--project', project, '--ticket', ticket];
    if (options.worktree) args.push('--worktree', options.worktree);
    const child = spawn(process.execPath, args, {
      cwd: options.cwd || project,
      env: process.env,
      windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('close', (status: number | null) => resolve(Object.freeze({ status, output })));
  });
}

async function waitForFile(filePath: string): Promise<void> {
  for (let attempts = 0; attempts < 100; attempts += 1) {
    if (fs.existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

// The blocker holds the slot until a second waiter has joined, then 700ms more, so the
// sibling's recorded wait starts after its own process startup instead of racing it.
function slotBlockerScript(started: string, observedSiblingCaptures: string, waitingDirectory: string): string {
  return [
    `const fs = require('node:fs');`,
    `fs.writeFileSync(${JSON.stringify(started)}, 'started');`,
    `fs.appendFileSync(${JSON.stringify(observedSiblingCaptures)}, process.env.SIDEQUEST_FULL_SUITE_SIBLING_CAPTURE_COUNT + '\\n');`,
    `const deadline = Date.now() + 10000;`,
    `function waiters() { try { return fs.readdirSync(${JSON.stringify(waitingDirectory)}).length; } catch { return 0; } }`,
    `(function hold() { if (waiters() >= 2 || Date.now() > deadline) return setTimeout(() => {}, 700); setTimeout(hold, 20); })();`,
  ].join(' ');
}

function readRecordedCaptures(project: string, ticket: string) {
  const reader = `const store = require(${JSON.stringify(path.join(SIDEQUEST_DIR, 'lib', 'store.js'))}); const target = store.findProject(process.argv.at(-2)); const list = store.getTicket(target.slug, process.argv.at(-1)).verificationCaptures; console.log(JSON.stringify(Array.isArray(list) ? list : []));`;
  return JSON.parse(execFileSync(process.execPath, ['--eval', reader, project, ticket], { encoding: 'utf8', env: process.env, windowsHide: true }));
}

function recordedCaptureCount(project: string, ticket: string): number {
  const reader = `const store = require(${JSON.stringify(path.join(SIDEQUEST_DIR, 'lib', 'store.js'))}); const target = store.findProject(process.argv.at(-2)); const list = store.getTicket(target.slug, process.argv.at(-1)).verificationCaptures; console.log(JSON.stringify(Array.isArray(list) ? list.length : 0));`;
  return JSON.parse(execFileSync(process.execPath, ['--eval', reader, project, ticket], { encoding: 'utf8', env: process.env, windowsHide: true }));
}

// GitHub #110 fixtures: an isolated-worktree dispatch whose ticket.dispatch.worktree is a real,
// bound, linked git worktree -- the same shape store/dispatch.ts and worktree-isolation.test.ts
// use, so the wrapper reads the exact dispatch record structure production code writes.
const isolatedDispatchCategory = store.getCategory('codebase-exploration');
store.setCategory(Object.assign({}, isolatedDispatchCategory, { route: { model: 'sonnet', effort: 'medium' }, fallback: null }));

function initGitRepo(prefix: string): string {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '-b', 'main', '--quiet'], { cwd: project, windowsHide: true });
  fs.writeFileSync(path.join(project, 'README.md'), 'fixture\n');
  execFileSync('git', ['add', '--all'], { cwd: project, windowsHide: true });
  execFileSync('git', ['-c', 'user.name=Sidequest Tests', '-c', 'user.email=sidequest@example.invalid', 'commit', '--quiet', '-m', 'fixture'], { cwd: project, windowsHide: true });
  return project;
}

function commitHead(cwd: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

// The store refuses to record a capture unless its command matches the ticket's own
// pinned verify command, so every fixture ticket declares this and every capture in
// these tests runs exactly this command.
const ISOLATED_DISPATCH_VERIFY_COMMAND = 'git rev-parse HEAD';

function setupIsolatedDispatch(agentId: string) {
  const project = initGitRepo(`sq-verify-capture-worktree-fixture-${agentId}-`);
  const { slug } = store.ensureProject(project);
  const ticket = store.createTicket(slug, {
    title: `isolated worktree fixture ${agentId}`,
    category: 'codebase-exploration',
    files: ['README.md'],
    executorVerifyKind: 'command',
    executorVerify: ISOLATED_DISPATCH_VERIFY_COMMAND,
  });
  const sessionId = `session-${agentId}`;
  const prepared = store.prepareDispatch(slug, ticket.ref, { sharedTree: false, sessionId });
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    token: prepared.token, executor: prepared.ticket.dispatchExecutor, sessionId, agentName: agentId,
  }).ok, true);
  const worktree = worktrees.resolvedAgentWorktree(project, agentId);
  assert.equal(store.bindDispatchWorktreeCreation(slug, sessionId, worktree).ok, true);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  execFileSync('git', ['worktree', 'add', '--detach', '--quiet', worktree], { cwd: project, windowsHide: true });
  const gitDirectoryValue = execFileSync('git', ['rev-parse', '--git-dir'], { cwd: worktree, encoding: 'utf8', windowsHide: true }).trim();
  const gitDirectory = path.isAbsolute(gitDirectoryValue) ? gitDirectoryValue : path.resolve(worktree, gitDirectoryValue);
  worktreeLease.createCheckoutInstanceMarker(gitDirectory);
  assert.equal(store.completeDispatchWorktreeCreation(slug, sessionId, worktree).ok, true);
  assert.equal(store.bindDispatchAgent(sessionId, prepared.ticket.dispatchExecutor, agentId, agentId, worktree).ok, true);
  return {
    project,
    slug,
    ticket: store.getTicket(slug, ticket.ref),
    worktree,
    cleanup() {
      execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: project, windowsHide: true });
      fs.rmSync(project, { recursive: true, force: true });
    },
  };
}

test('full-suite capture serializes sibling captures and records the queue wait', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-verify-capture-slot-'));
  const started = path.join(project, 'started');
  const observedSiblingCaptures = path.join(project, 'observed-sibling-captures');
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ scripts: { 'test:full': 'node blocker.js' } }));
  execFileSync('git', ['init', '-b', 'main', '--quiet'], { cwd: project, windowsHide: true });
  fs.writeFileSync(path.join(project, 'blocker.js'), slotBlockerScript(started, observedSiblingCaptures, path.join(captureSlotDirectory(project), 'waiting')));
  fs.writeFileSync(path.join(project, '.gitignore'), 'started\nobserved-sibling-captures\n');
  execFileSync('git', ['add', '--all'], { cwd: project, windowsHide: true });
  execFileSync('git', ['-c', 'user.name=Sidequest Tests', '-c', 'user.email=sidequest@example.invalid', 'commit', '--quiet', '-m', 'fixture'], { cwd: project, windowsHide: true });
  const boardProject = store.ensureProject(project);
  const ticket = store.createTicket(boardProject.slug, {
    title: 'serialize full-suite verification captures',
    executorVerifyKind: 'command',
    executorVerify: 'npm run test:full',
  });

  try {
    const first = runCaptureProcess('npm run test:full', project, ticket.ref);
    await waitForFile(started);
    const second = runCaptureProcess('npm run test:full', project, ticket.ref);
    const [firstResult, secondResult] = await Promise.all([first, second]);

    assert.equal(firstResult.status, 0, firstResult.output);
    assert.equal(secondResult.status, 0, secondResult.output);
    assert.deepEqual(fs.readFileSync(observedSiblingCaptures, 'utf8').trim().split(/\r?\n/).sort(), ['0', '1']);
    assert.match(secondResult.output, /waiting for 1 sibling capture to finish \(queue position 2\)/);
    const captures = readRecordedCaptures(project, ticket.ref);
    const waitedCapture = captures.find((capture: { queuePosition?: number }) => capture.queuePosition === 2);
    assert.ok(waitedCapture, 'the second capture records its slot queue position');
    assert.equal(waitedCapture.queuePosition, 2);
    assert.ok(waitedCapture.waitedForSlotMs >= 500, `waited ${waitedCapture.waitedForSlotMs}ms`);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('synchronous full-suite verification uses the capture slot', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-verify-capture-integration-slot-'));
  const started = path.join(project, 'started');
  const observedSiblingCaptures = path.join(project, 'observed-sibling-captures');
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ scripts: { 'test:full': 'node blocker.js' } }));
  execFileSync('git', ['init', '-b', 'main', '--quiet'], { cwd: project, windowsHide: true });
  fs.writeFileSync(path.join(project, 'blocker.js'), slotBlockerScript(started, observedSiblingCaptures, path.join(captureSlotDirectory(project), 'waiting')));
  execFileSync('git', ['add', '--all'], { cwd: project, windowsHide: true });
  execFileSync('git', ['-c', 'user.name=Sidequest Tests', '-c', 'user.email=sidequest@example.invalid', 'commit', '--quiet', '-m', 'fixture'], { cwd: project, windowsHide: true });

  try {
    const first = runCaptureProcess('npm run test:full', project, 'SQ-1');
    await waitForFile(started);
    const capture = runFullSuiteVerification('npm run test:full', project, (environment: NodeJS.ProcessEnv) => runProcessVerification(
      { kind: 'command', command: 'npm run test:full', evidenceContract: 'command output' },
      { cwd: project, environment },
    ));
    const firstResult = await first;

    assert.equal(firstResult.status, 2, firstResult.output);
    assert.deepEqual({ status: capture.status, exitCode: capture.exitCode }, { status: 'passed', exitCode: 0 });
    assert.equal(capture.queuePosition, 2);
    assert.ok(capture.waitedForSlotMs >= 500, `waited ${capture.waitedForSlotMs}ms`);
    assert.deepEqual(fs.readFileSync(observedSiblingCaptures, 'utf8').trim().split(/\r?\n/).sort(), ['0', '1']);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(captureSlotDirectory(project), { recursive: true, force: true });
  }
});

test('a failed synchronous slot release still removes its own waiter', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-verify-capture-release-failure-'));
  execFileSync('git', ['init', '-b', 'main', '--quiet'], { cwd: project, windowsHide: true });
  const slotDirectory = captureSlotDirectory(project);
  const activeDirectory = path.join(slotDirectory, 'active');
  const fileSystem = Object.create(fs);
  fileSystem.renameSync = (source: string, target: string) => {
    if (source === activeDirectory) throw Object.assign(new Error('held by scanner'), { code: 'EPERM' });
    return fs.renameSync(source, target);
  };

  try {
    const capture = runFullSuiteVerification('npm run test:full', project, () => ({
      kind: 'command', status: 'passed', evidence: 'probe passed', command: 'npm run test:full', logPath: null, exitCode: 0, outputTail: null, failureIdentities: [],
    }), fileSystem);

    assert.equal(capture.status, 'could_not_run');
    assert.deepEqual(fs.readdirSync(path.join(slotDirectory, 'waiting')), [], 'the board process must not leave a live-PID waiter behind');
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(slotDirectory, { recursive: true, force: true });
  }
});

test('full-suite capture retries EPERM while a sibling releases its slot', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-verify-capture-eperm-'));
  const observedSiblingCaptures = path.join(project, 'observed-sibling-captures');
  const slotDirectory = captureSlotDirectory(project);
  const activeDirectory = path.join(slotDirectory, 'active');
  const siblingWaiterPath = path.join(slotDirectory, 'waiting', `000000000000001-${process.pid}-sibling.json`);
  const siblingTombstoneDirectory = `${activeDirectory}.sibling-release`;
  let releaseTimer: NodeJS.Timeout | undefined;

  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ scripts: { 'test:full': 'node blocker.js' } }));
  fs.writeFileSync(path.join(project, 'blocker.js'), `require('node:fs').writeFileSync(${JSON.stringify(observedSiblingCaptures)}, process.env.SIDEQUEST_FULL_SUITE_SIBLING_CAPTURE_COUNT);`);
  execFileSync('git', ['init', '-b', 'main', '--quiet'], { cwd: project, windowsHide: true });
  execFileSync('git', ['add', '--all'], { cwd: project, windowsHide: true });
  execFileSync('git', ['-c', 'user.name=Sidequest Tests', '-c', 'user.email=sidequest@example.invalid', 'commit', '--quiet', '-m', 'fixture'], { cwd: project, windowsHide: true });
  const boardProject = store.ensureProject(project);
  const ticket = store.createTicket(boardProject.slug, {
    title: 'retry full-suite capture while a sibling releases',
    executorVerifyKind: 'command',
    executorVerify: 'npm run test:full',
  });
  fs.mkdirSync(path.dirname(siblingWaiterPath), { recursive: true });
  fs.writeFileSync(siblingWaiterPath, '');
  fs.mkdirSync(activeDirectory, { recursive: true });

  let activeMkdirAttempts = 0;
  const fileSystem = Object.create(fs);
  fileSystem.mkdirSync = (directory: string, options?: unknown) => {
    if (directory === activeDirectory) {
      activeMkdirAttempts += 1;
      if (activeMkdirAttempts === 1) throw Object.assign(new Error('active directory is changing'), { code: 'EPERM' });
    }
    return fs.mkdirSync(directory, options);
  };

  try {
    releaseTimer = setTimeout(() => {
      fs.renameSync(activeDirectory, siblingTombstoneDirectory);
      fs.rmSync(siblingTombstoneDirectory, { recursive: true, force: true });
      fs.rmSync(siblingWaiterPath, { force: true });
    }, 50);
    const { capture, recorded } = await runCapturedVerification('npm run test:full', { project, ticket: ticket.ref }, project, fileSystem);

    assert.deepEqual({ status: capture.status, exitCode: capture.exitCode }, { status: 'passed', exitCode: 0 });
    assert.equal(activeMkdirAttempts, 2);
    assert.equal(capture.queuePosition, 2);
    assert.ok(capture.waitedForSlotMs >= 50, `waited ${capture.waitedForSlotMs}ms`);
    assert.equal(fs.readFileSync(observedSiblingCaptures, 'utf8'), '1');
    assert.ok(recorded?.ok, recorded?.reason);
    const recordedWait = readRecordedCaptures(project, ticket.ref).find((entry: { queuePosition?: number }) => entry.queuePosition === 2);
    assert.ok(recordedWait, 'the EPERM-retried capture records its slot queue position');
  } finally {
    if (releaseTimer) clearTimeout(releaseTimer);
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(slotDirectory, { recursive: true, force: true });
  }
});

test('full-suite slots resolve linked worktrees to their common repository root', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-verify-capture-worktree-'));
  const worktree = `${project}-linked`;
  try {
    fs.writeFileSync(path.join(project, 'fixture'), 'fixture');
    execFileSync('git', ['init', '-b', 'main', '--quiet'], { cwd: project, windowsHide: true });
    execFileSync('git', ['add', '--all'], { cwd: project, windowsHide: true });
    execFileSync('git', ['-c', 'user.name=Sidequest Tests', '-c', 'user.email=sidequest@example.invalid', 'commit', '--quiet', '-m', 'fixture'], { cwd: project, windowsHide: true });
    execFileSync('git', ['worktree', 'add', '--detach', '--quiet', worktree], { cwd: project, windowsHide: true });

    assert.equal(captureSlotDirectory(worktree), captureSlotDirectory(project));
  } finally {
    fs.rmSync(worktree, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('full-suite capture reclaims a killed owner without waiting for the slot timeout', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-verify-capture-stale-'));
  const slotDirectory = captureSlotDirectory(project);
  const activeDirectory = path.join(slotDirectory, 'active');
  let staleWaiterPath = '';
  try {
    fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ scripts: { 'test:full': 'node blocker.js' } }));
    fs.writeFileSync(path.join(project, 'blocker.js'), '');
    execFileSync('git', ['init', '-b', 'main', '--quiet'], { cwd: project, windowsHide: true });
    execFileSync('git', ['add', '--all'], { cwd: project, windowsHide: true });
    execFileSync('git', ['-c', 'user.name=Sidequest Tests', '-c', 'user.email=sidequest@example.invalid', 'commit', '--quiet', '-m', 'fixture'], { cwd: project, windowsHide: true });
    const boardProject = store.ensureProject(project);
    const ticket = store.createTicket(boardProject.slug, {
      title: 'reclaim stale full-suite capture owner',
      executorVerifyKind: 'command',
      executorVerify: 'npm run test:full',
    });
    const killedOwner = spawn(process.execPath, ['--eval', ''], { windowsHide: true });
    const killedOwnerProcessId = await new Promise<number>((resolve, reject) => {
      killedOwner.once('error', reject);
      killedOwner.once('close', () => resolve(killedOwner.pid || 0));
    });
    assert.ok(killedOwnerProcessId > 0);
    fs.mkdirSync(path.join(slotDirectory, 'waiting'), { recursive: true });
    staleWaiterPath = path.join(slotDirectory, 'waiting', `000000000000001-${killedOwnerProcessId}-stale.json`);
    fs.writeFileSync(staleWaiterPath, '');
    fs.mkdirSync(activeDirectory);

    const { capture, recorded } = await runCapturedVerification('npm run test:full', { project, ticket: ticket.ref }, project);

    assert.deepEqual({ status: capture.status, exitCode: capture.exitCode }, { status: 'passed', exitCode: 0 });
    assert.equal(capture.queuePosition, 1);
    assert.ok(capture.waitedForSlotMs < 1_000, `waited ${capture.waitedForSlotMs}ms`);
    assert.equal(fs.existsSync(staleWaiterPath), false);
    assert.ok(recorded?.ok, recorded?.reason);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(slotDirectory, { recursive: true, force: true });
  }
});

test('verify capture runs generated POSIX scripts through the host shell', () => {
  const shell = shellCommand('verify-script.sh', 'linux');
  assert.deepStrictEqual(shell.arguments, ['verify-script.sh']);
});

test('verify capture executes through the shared process port and preserves result classes', async () => {
  const passed = await runVerifyCapture('cd . && echo verify-capture-ran');
  try {
    assert.deepStrictEqual({ status: passed.status, exitCode: passed.exitCode }, { status: 'passed', exitCode: 0 });
    assert.match(fs.readFileSync(passed.logPath, 'utf8'), /verify-capture-ran/);
  } finally {
    deleteLog(passed);
  }

  const failed = await runVerifyCapture('exit 7');
  try {
    assert.deepStrictEqual({ status: failed.status, exitCode: failed.exitCode }, { status: 'failed_suite', exitCode: 7 });
  } finally {
    deleteLog(failed);
  }

  const missingCommand = `sidequest-missing-command-${process.pid}-${Date.now()}`;
  const unavailableCommand = await runVerifyCapture(missingCommand);
  try {
    assert.equal(unavailableCommand.status, 'toolchain_missing');
    assert.notEqual(unavailableCommand.exitCode, 0);
    assert.match(unavailableCommand.reason || '', new RegExp(missingCommand));
  } finally {
    deleteLog(unavailableCommand);
  }

  const shellEnvironment = process.platform === 'win32' ? 'ComSpec' : 'SHELL';
  const originalShell = process.env[shellEnvironment];
  const originalPath = process.env.PATH;
  const originalPathAlias = process.env.Path;
  const originalProgramFiles = [process.env.ProgramW6432, process.env.ProgramFiles, process.env['ProgramFiles(x86)']];
  const missingShell = path.join(os.tmpdir(), 'sidequest-missing-capture-shell');
  process.env[shellEnvironment] = missingShell;
  if (process.platform === 'win32') {
    process.env.ProgramW6432 = missingShell;
    process.env.ProgramFiles = missingShell;
    process.env['ProgramFiles(x86)'] = missingShell;
    process.env.Path = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
    process.env.PATH = process.env.Path;
  }
  try {
    const unavailable = await runVerifyCapture('echo unreachable');
    try {
      assert.equal(unavailable.status, 'could_not_run');
      assert.equal(unavailable.exitCode, 2);
    } finally {
      deleteLog(unavailable);
    }
    if (process.platform === 'win32') {
      process.env.ComSpec = originalShell || 'cmd.exe';
      const syntaxFailure = await runVerifyCapture('cd . && ! grep -q zzz README.md', SIDEQUEST_DIR);
      try {
        assert.deepStrictEqual({ status: syntaxFailure.status, exitCode: syntaxFailure.exitCode }, { status: 'could_not_run', exitCode: 1 });
        assert.match(syntaxFailure.reason || '', /could not parse POSIX syntax/);
        assert.match(syntaxFailure.shell || '', /Command Prompt/i);
      } finally {
        deleteLog(syntaxFailure);
      }
    }
  } finally {
    if (originalShell === undefined) delete process.env[shellEnvironment];
    else process.env[shellEnvironment] = originalShell;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalPathAlias === undefined) delete process.env.Path;
    else process.env.Path = originalPathAlias;
    for (const [name, value] of [['ProgramW6432', originalProgramFiles[0]], ['ProgramFiles', originalProgramFiles[1]], ['ProgramFiles(x86)', originalProgramFiles[2]]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('verify capture returns after a Windows batch command', { skip: process.platform !== 'win32' }, async () => {
  const capture = await runVerifyCapture('npm --version');
  try {
    assert.deepStrictEqual({ status: capture.status, exitCode: capture.exitCode }, { status: 'passed', exitCode: 0 });
    assert.match(fs.readFileSync(capture.logPath, 'utf8'), /\d+\.\d+\.\d+/);
  } finally {
    deleteLog(capture);
  }
});

test('verify capture runs POSIX syntax through a POSIX shell on Windows', { skip: process.platform !== 'win32' }, async () => {
  const capture = await runVerifyCapture('cd . && ! grep -q zzz README.md', SIDEQUEST_DIR);
  try {
    assert.deepStrictEqual({ status: capture.status, exitCode: capture.exitCode }, { status: 'passed', exitCode: 0 });
    assert.match(capture.shell || '', /POSIX shell/i);
    assert.match(fs.readFileSync(capture.logPath, 'utf8'), /__SIDEQUEST_VERIFY_EXIT__=0/);
  } finally {
    deleteLog(capture);
  }
});

test('verify capture returns a timeout with partial output', async () => {
  const slowCommand = process.platform === 'win32'
    ? 'echo partial-output && ping -n 30 127.0.0.1'
    : 'printf partial-output; sleep 30';
  // The child has to get its first write through the pipe before the deadline kills it, so this bound is
  // racing process startup, not measuring anything. At 100ms the echo lost that race under full-gate load
  // and the log came back empty on unchanged code, the same way the tuned bounds in SQ-2179 and SQ-2191
  // did. Two seconds is still nowhere near the 30s the command would otherwise run for, so the timeout
  // path is exactly as covered as before.
  const timeoutMilliseconds = 2000;
  const capture = await runVerifyCapture(slowCommand, process.cwd(), timeoutMilliseconds);
  try {
    assert.deepStrictEqual(
      { status: capture.status, exitCode: capture.exitCode },
      { status: 'timeout', exitCode: 2 },
    );
    assert.equal(capture.reason, `Verification timed out after ${timeoutMilliseconds}ms; partial output captured.`);
    assert.match(fs.readFileSync(capture.logPath, 'utf8'), /partial-output/);
  } finally {
    deleteLog(capture);
  }
});

// SQ-2884. A cross-project dispatch runs its executor in the spawning checkout,
// where the ticket's files do not exist. That is the input which makes a false pass
// look real: every grep in a negated doc check fails to match, every negation
// succeeds, and the capture records passed with exit 0 over a repository nothing
// read. Both halves of the fix are checked against the same fixture.
function siblingRepositories(prefix: string) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const seed = (repository: string) => {
    fs.mkdirSync(repository, { recursive: true });
    execFileSync('git', ['init', '-b', 'main', '--quiet'], { cwd: repository, windowsHide: true });
    fs.writeFileSync(path.join(repository, 'seed'), 'seed\n');
    execFileSync('git', ['add', '--all'], { cwd: repository, windowsHide: true });
    execFileSync('git', ['-c', 'user.name=Sidequest Tests', '-c', 'user.email=sidequest@example.invalid', 'commit', '--quiet', '-m', 'fixture'], { cwd: repository, windowsHide: true });
  };
  const parent = path.join(root, 'parent');
  const child = path.join(root, 'child');
  seed(parent);
  seed(child);
  return { root, parent, child };
}

function negatedGrepTicket(child: string, phrase: string) {
  fs.mkdirSync(path.join(child, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(child, 'docs', 'NOTES.md'), `the ${phrase} is documented here\n`);
  execFileSync('git', ['add', '--all'], { cwd: child, windowsHide: true });
  execFileSync('git', ['-c', 'user.name=Sidequest Tests', '-c', 'user.email=sidequest@example.invalid', 'commit', '--quiet', '-m', 'verification fixture'], { cwd: child, windowsHide: true });
  const boardProject = store.ensureProject(child);
  const command = `cd . && ! grep -rn "${phrase}" docs/`;
  const ticket = store.createTicket(boardProject.slug, {
    title: 'cross-project negated grep verification',
    executorVerifyKind: 'command',
    executorVerify: command,
  });
  return { command, ticket };
}

test('a negated-grep verify runs in the ticket repository, not the spawning checkout', async () => {
  const { root, parent, child } = siblingRepositories('sq-verify-capture-cross-project-');
  const { command, ticket } = negatedGrepTicket(child, 'banned-phrase');
  try {
    const falsePass = await runVerifyCapture(command, parent);
    try {
      assert.deepEqual({ status: falsePass.status, exitCode: falsePass.exitCode }, { status: 'passed', exitCode: 0 }, 'the reproduction only matters while this command passes in the wrong repository');
    } finally {
      deleteLog(falsePass);
    }

    const { capture, recorded } = await runCapturedVerification(command, { project: child, ticket: ticket.ref }, parent);
    try {
      assert.equal(capture.status, 'failed_suite');
      assert.ok(recorded?.ok, recorded?.reason);
      const captured = readRecordedCaptures(child, ticket.ref).at(-1);
      assert.equal(captured.status, 'failed_suite');
      assert.equal(path.resolve(captured.worktree), path.resolve(child));
    } finally {
      deleteLog(capture);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a capture over uncommitted tracked changes is not recorded', () => {
  const { root, child } = siblingRepositories('sq-verify-capture-dirty-worktree-');
  const { command, ticket } = negatedGrepTicket(child, 'dirty-worktree-phrase');
  const target = { project: child, ticket: ticket.ref };
  const passing = { command, status: 'passed', exitCode: 0, logPath: null, shell: 'fixture' };
  try {
    fs.writeFileSync(path.join(child, 'seed'), 'dirty\n');
    const refused = recordCapture(target, passing, child);
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'verification_capture_dirty_worktree');
    assert.match(refused.message, /Commit or discard/);
    assert.deepEqual(readRecordedCaptures(child, ticket.ref), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a capture that ran outside the ticket repository is not recorded', () => {
  const { root, parent, child } = siblingRepositories('sq-verify-capture-foreign-repo-');
  const { command, ticket } = negatedGrepTicket(child, 'foreign-phrase');
  const target = { project: child, ticket: ticket.ref };
  const passing = { command, status: 'passed', exitCode: 0, logPath: null, shell: 'fixture' };
  try {
    assert.equal(recordCapture(target, passing, child).ok, true);

    const refused = recordCapture(target, passing, parent);
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'verification_capture_foreign_repository');
    assert.match(refused.message, /proves nothing about them/);
    assert.equal(readRecordedCaptures(child, ticket.ref).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('verify capture preserves quoted absolute paths in verify commands', async () => {
  const scriptPath = path.join(os.tmpdir(), `sidequest quoted ${Date.now()}.js`);
  fs.writeFileSync(scriptPath, 'process.stdout.write(process.argv[2] + \'\\n\');\n', 'utf8');
  const capture = await runVerifyCapture(nodeCommand(scriptPath, scriptPath));
  try {
    assert.deepStrictEqual({ status: capture.status, exitCode: capture.exitCode }, { status: 'passed', exitCode: 0 });
    assert.match(fs.readFileSync(capture.logPath, 'utf8'), new RegExp(scriptPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    fs.rmSync(scriptPath, { force: true });
    deleteLog(capture);
  }
});

test('verify capture passes an unquoted [param] dynamic-route path through literally', { skip: !UNQUOTED_GLOB_SHELL }, async () => {
  const scriptPath = path.join(os.tmpdir(), `sidequest-unquoted-glob-${Date.now()}.js`);
  fs.writeFileSync(scriptPath, 'process.stdout.write(process.argv[2] + \'\\n\');\n', 'utf8');
  const dynamicRoutePath = 'src/app/fulfillments/[fulfillmentId]/pick/pick-row.test.ts';
  const originalShell = process.env.SHELL;
  process.env.SHELL = UNQUOTED_GLOB_SHELL as string;
  try {
    const capture = await runVerifyCapture(`"${process.execPath}" "${scriptPath}" ${dynamicRoutePath}`);
    try {
      assert.deepStrictEqual({ status: capture.status, exitCode: capture.exitCode }, { status: 'passed', exitCode: 0 });
      if (ZSH_EXECUTABLE) assert.match(capture.shell || '', /zsh/i);
      assert.match(fs.readFileSync(capture.logPath, 'utf8'), /fulfillments\/\[fulfillmentId\]\/pick\/pick-row\.test\.ts/);
    } finally {
      fs.rmSync(scriptPath, { force: true });
      deleteLog(capture);
    }
  } finally {
    if (originalShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = originalShell;
  }
});

// GitHub #110: the wrapper's candidate came from process.cwd() at invocation, with nothing
// refusing a run from the wrong checkout of the same repository. An isolated-worktree
// executor that ran the briefing command from the shared registered checkout got a
// plausible-looking green recorded against a revision it never touched.

test('(a) --worktree binds the capture cwd and recorded revision to the named worktree, even when cwd is elsewhere', async () => {
  const fixture = setupIsolatedDispatch('worktree-flag-bound');
  try {
    // Diverge the shared checkout's HEAD from the bound worktree's HEAD after the worktree
    // was created, so a capture reading the wrong cwd is distinguishable from one reading W's.
    fs.writeFileSync(path.join(fixture.project, 'diverged.txt'), 'diverged\n');
    execFileSync('git', ['add', '--all'], { cwd: fixture.project, windowsHide: true });
    execFileSync('git', ['-c', 'user.name=Sidequest Tests', '-c', 'user.email=sidequest@example.invalid', 'commit', '--quiet', '-m', 'diverge project head'], { cwd: fixture.project, windowsHide: true });
    const projectHead = commitHead(fixture.project);
    const worktreeHead = commitHead(fixture.worktree);
    assert.notEqual(projectHead, worktreeHead, 'fixture must diverge the two HEADs to be meaningful');

    const { status, output } = await runCaptureProcess(ISOLATED_DISPATCH_VERIFY_COMMAND, fixture.project, fixture.ticket.ref, {
      worktree: fixture.worktree,
      cwd: fixture.project,
    });
    assert.equal(status, 0, output);

    const captures = readRecordedCaptures(fixture.project, fixture.ticket.ref);
    const recorded = captures.at(-1);
    assert.equal(worktreeLease.canonicalPath(recorded.worktree), worktreeLease.canonicalPath(fixture.worktree));
    assert.equal(recorded.candidate.value, worktreeHead.toLowerCase());
    assert.notEqual(recorded.candidate.value, projectHead.toLowerCase());
  } finally {
    fixture.cleanup();
  }
});

test('(b) without --worktree, cwd outside the ticket\'s bound worktree refuses and records nothing', async () => {
  const fixture = setupIsolatedDispatch('worktree-refusal');
  try {
    const { status, output } = await runCaptureProcess(ISOLATED_DISPATCH_VERIFY_COMMAND, fixture.project, fixture.ticket.ref, {
      cwd: fixture.project,
    });
    assert.notEqual(status, 0, output);
    const canonicalWorktree = worktreeLease.canonicalPath(fixture.worktree);
    assert.ok(output.includes(canonicalWorktree), output);
    assert.ok(/run (it|this command) from/i.test(output), output);
    assert.equal(recordedCaptureCount(fixture.project, fixture.ticket.ref), 0);
  } finally {
    fixture.cleanup();
  }
});

test('(c) without --worktree, cwd already inside the ticket\'s bound worktree records as today', async () => {
  const fixture = setupIsolatedDispatch('worktree-inside');
  try {
    const { status, output } = await runCaptureProcess(ISOLATED_DISPATCH_VERIFY_COMMAND, fixture.project, fixture.ticket.ref, {
      cwd: fixture.worktree,
    });
    assert.equal(status, 0, output);
    const captures = readRecordedCaptures(fixture.project, fixture.ticket.ref);
    const recorded = captures.at(-1);
    assert.equal(worktreeLease.canonicalPath(recorded.worktree), worktreeLease.canonicalPath(fixture.worktree));
    assert.equal(recorded.candidate.value, commitHead(fixture.worktree).toLowerCase());
  } finally {
    fixture.cleanup();
  }
});

test('(e) --worktree naming any tree other than the bound one refuses and records nothing, even with the same HEAD', async () => {
  const fixture = setupIsolatedDispatch('worktree-flag-mismatch');
  try {
    assert.equal(commitHead(fixture.project), commitHead(fixture.worktree), 'fixture must share HEAD so only the tree identity distinguishes the runs');
    const { status, output } = await runCaptureProcess(ISOLATED_DISPATCH_VERIFY_COMMAND, fixture.project, fixture.ticket.ref, {
      worktree: fixture.project,
      cwd: fixture.worktree,
    });
    assert.notEqual(status, 0, output);
    assert.ok(output.includes(worktreeLease.canonicalPath(fixture.worktree)), output);
    assert.ok(output.includes(worktreeLease.canonicalPath(fixture.project)), output);
    assert.equal(recordedCaptureCount(fixture.project, fixture.ticket.ref), 0);
  } finally {
    fixture.cleanup();
  }
});

test('(f) a bound-worktree child directory whose name starts with two dots still counts as inside', async () => {
  const fixture = setupIsolatedDispatch('worktree-dotdot-child');
  try {
    const child = path.join(fixture.worktree, '..valid');
    fs.mkdirSync(child);
    const { status, output } = await runCaptureProcess(ISOLATED_DISPATCH_VERIFY_COMMAND, fixture.project, fixture.ticket.ref, {
      cwd: child,
    });
    assert.equal(status, 0, output);
    assert.equal(recordedCaptureCount(fixture.project, fixture.ticket.ref), 1);
  } finally {
    fixture.cleanup();
  }
});

test('(d) a working-tree-delivery ticket keeps its shared-checkout override unchanged', async () => {
  const project = initGitRepo('sq-verify-capture-wtd-fixture-');
  const { slug } = store.ensureProject(project);
  store.setCategory({ id: 'repository-write-wtd-fixture', name: 'Repository write (fixture)', route: { model: 'sonnet', effort: 'medium' }, artifactRoots: [] });
  const ticket = store.createTicket(slug, {
    title: 'working-tree-delivery fixture',
    category: 'repository-write-wtd-fixture',
    files: ['README.md'],
    workingTreeDelivery: true,
    executorVerifyKind: 'command',
    executorVerify: ISOLATED_DISPATCH_VERIFY_COMMAND,
    source: 'mcp',
  });
  const prepared = store.prepareDispatch(slug, ticket.ref, { sharedTree: true });
  const claimed = store.claimTicket(slug, ticket.ref, 'wtd-owner', {
    token: prepared.token, executor: prepared.ticket.dispatchExecutor, source: 'mcp',
  });
  assert.equal(claimed.ok, true, JSON.stringify(claimed));
  try {
    const outsideCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-verify-capture-wtd-cwd-'));
    try {
      const { status, output } = await runCaptureProcess(ISOLATED_DISPATCH_VERIFY_COMMAND, project, ticket.ref, { cwd: outsideCwd });
      assert.equal(status, 0, output);
      const captures = readRecordedCaptures(project, ticket.ref);
      const recorded = captures.at(-1);
      // Unchanged behaviour: the working-tree-delivery override still wins and runs the
      // shared checkout, regardless of where the wrapper was invoked from.
      assert.equal(worktreeLease.canonicalPath(recorded.worktree), worktreeLease.canonicalPath(project));
    } finally {
      fs.rmSync(outsideCwd, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});
