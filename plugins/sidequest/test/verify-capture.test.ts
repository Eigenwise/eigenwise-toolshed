import './_temp-cleanup.js';
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const { runVerifyCapture, runCapturedVerification, shellCommand, captureSlotDirectory, recordCapture } = require('../lib/verify-capture.js');
const store = require('../lib/store.js');
const SIDEQUEST_DIR = path.resolve(__dirname, '..');

function deleteLog(capture: { logPath: string }) {
  fs.rmSync(capture.logPath, { force: true });
}

function nodeCommand(scriptPath: string, argument: string) {
  return `"${process.execPath}" "${scriptPath}" "${argument}"`;
}

function runCaptureProcess(command: string, project: string, ticket: string): Promise<Readonly<{ status: number | null; output: string }>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(SIDEQUEST_DIR, 'lib', 'verify-capture.js'), '--base64', Buffer.from(command).toString('base64'), '--project', project, '--ticket', ticket], {
      cwd: project,
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

function readRecordedCaptures(project: string, ticket: string) {
  const reader = `const store = require(${JSON.stringify(path.join(SIDEQUEST_DIR, 'lib', 'store.js'))}); const target = store.findProject(process.argv.at(-2)); console.log(JSON.stringify(store.getTicket(target.slug, process.argv.at(-1)).verificationCaptures));`;
  return JSON.parse(execFileSync(process.execPath, ['--eval', reader, project, ticket], { encoding: 'utf8', env: process.env, windowsHide: true }));
}

test('full-suite capture serializes sibling captures and records the queue wait', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-verify-capture-slot-'));
  const started = path.join(project, 'started');
  const observedSiblingCaptures = path.join(project, 'observed-sibling-captures');
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ scripts: { 'test:full': 'node blocker.js' } }));
  fs.writeFileSync(path.join(project, 'blocker.js'), `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(started)}, 'started'); fs.appendFileSync(${JSON.stringify(observedSiblingCaptures)}, process.env.SIDEQUEST_FULL_SUITE_SIBLING_CAPTURE_COUNT + '\\n'); setTimeout(() => {}, 700);`);
  execFileSync('git', ['init', '-b', 'main', '--quiet'], { cwd: project, windowsHide: true });
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
