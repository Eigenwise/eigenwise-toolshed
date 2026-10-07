import './_temp-cleanup.js';
import './_sidequest-install-fixture.js';
import type { SpawnOptions } from 'node:child_process';
import type { TestContext } from 'node:test';
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { runVerifyCapture, recordCapture } = require('../lib/verify-capture.js');
const { runProcessVerification, runOwnedProcessVerification } = require('../lib/ports/process.js');
const { classifyProcessState, compileJobOwner } = require('../scripts/owned-process-tree.js');
const store = require('../lib/store.js');

const windowsOnly = process.platform === 'win32' ? {} : { skip: 'Windows Job Objects' };
const FIXTURE_DEADLINE_MILLISECONDS = 5000;
const SETTLED_BUDGET_MILLISECONDS = 5000;
// At most two processors for the fixture tree, enforced by the job and read back from inside it.
const TWO_CORE_AFFINITY_MASK = '3';

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readWhenWritten(filePath: string): Promise<string> {
  const deadline = Date.now() + SETTLED_BUDGET_MILLISECONDS * 2;
  while (!fs.existsSync(filePath) && Date.now() < deadline) await delay(20);
  return fs.readFileSync(filePath, 'utf8');
}

async function stateAfterSettling(processId: number) {
  const deadline = Date.now() + SETTLED_BUDGET_MILLISECONDS;
  while (classifyProcessState(processId) === 'live' && Date.now() < deadline) await delay(20);
  return classifyProcessState(processId);
}

function killIfLive(processId: number) {
  if (classifyProcessState(processId) === 'live') process.kill(processId, 'SIGKILL');
}

// The runner is plain CommonJS with no declaration file; this is the slice of its shape these tests use.
type OwnedPhaseRunner = (options: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMilliseconds: number;
  terminationGraceMilliseconds: number;
  forwardStdout(chunk: Buffer): void;
  forwardStderr(chunk: Buffer): void;
}) => Promise<{ timedOut: boolean; cleanupError: string | null; jobClosedProcessIds: number[] | null }>;

// Re-requires the runner behind a spawn that loses the owner's exit request, so only the SIGKILL
// escalation ends the owner and it dies without accounting for its job.
function runnerWhoseOwnerIgnoresExitRequests(context: TestContext) {
  const childProcesses: typeof import('node:child_process') = require('node:child_process');
  const spawnOwner = childProcesses.spawn;
  context.mock.method(childProcesses, 'spawn', (command: string, argumentsList: string[], options: SpawnOptions) => {
    const owner = spawnOwner(command, argumentsList, options);
    context.mock.method(owner.stdin!, 'end', () => owner.stdin);
    return owner;
  });
  const runnerModulePath = require.resolve('../scripts/owned-process-tree.js');
  const cachedRunner = require.cache[runnerModulePath];
  delete require.cache[runnerModulePath];
  const runner: { runOwnedPhase: OwnedPhaseRunner } = require(runnerModulePath);
  context.after(() => { require.cache[runnerModulePath] = cachedRunner; });
  return runner.runOwnedPhase;
}

function commitAll(repository: string) {
  execFileSync('git', ['add', '--all'], { cwd: repository, windowsHide: true });
  execFileSync('git', ['-c', 'user.name=Sidequest Tests', '-c', 'user.email=sidequest@example.invalid', 'commit', '--quiet', '-m', 'fixture'], { cwd: repository, windowsHide: true });
}

// The verify runs cmd.exe -> node sleeper -> detached node grandchild. The unquoted `.\sleeper.js`
// routes it through Command Prompt, as a backslash path does for a real consumer's verify.
function nestedVerifyFixture(prefix: string) {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const evidence = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}evidence-`));
  execFileSync('git', ['init', '-b', 'main', '--quiet'], { cwd: repository, windowsHide: true });
  fs.writeFileSync(path.join(repository, 'grandchild.js'), [
    "const fs = require('node:fs');",
    "const report = JSON.stringify({ pid: process.pid, parallelism: require('node:os').availableParallelism() });",
    "fs.writeFileSync(process.argv[2] + '.partial', report);",
    "fs.renameSync(process.argv[2] + '.partial', process.argv[2]);",
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(repository, 'sleeper.js'), [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const grandchild = spawn(process.execPath, [path.join(__dirname, 'grandchild.js'), process.argv[2]], { detached: true, stdio: 'ignore', windowsHide: true });",
    'grandchild.unref();',
    "fs.writeFileSync(process.argv[3] + '.partial', String(process.pid));",
    "fs.renameSync(process.argv[3] + '.partial', process.argv[3]);",
    "process.stdout.write('sleeper started\\n');",
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n'));
  commitAll(repository);
  const grandchildReport = path.join(evidence, 'grandchild.json');
  const sleeperPidPath = path.join(evidence, 'sleeper.pid');
  const grandchild = async () => JSON.parse(await readWhenWritten(grandchildReport)) as { pid: number; parallelism: number };
  const sleeperPid = async () => Number(await readWhenWritten(sleeperPidPath));
  return {
    repository,
    command: `"${process.execPath}" .\\sleeper.js "${grandchildReport}" "${sleeperPidPath}"`,
    sleeperArguments: [path.join(repository, 'sleeper.js'), grandchildReport, sleeperPidPath],
    grandchild,
    sleeperPid,
    // Ends whatever a failed run left behind, so a leaked tree fails its assertion instead of the cleanup.
    cleanup: async () => {
      const leftovers = [
        ...(fs.existsSync(grandchildReport) ? [(await grandchild()).pid] : []),
        ...(fs.existsSync(sleeperPidPath) ? [await sleeperPid()] : []),
      ];
      leftovers.forEach(killIfLive);
      for (const processId of leftovers) await stateAfterSettling(processId);
      // The synchronous rm retries only ENOTEMPTY; a cmd.exe still exiting in the directory reports EBUSY.
      await fs.promises.rm(repository, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      fs.rmSync(evidence, { recursive: true, force: true });
    },
  };
}

test('a timed-out verify ends cmd, its node child and a detached grandchild, and the capture records the cleanup as a failure', { ...windowsOnly, timeout: 120_000 }, async () => {
  const fixture = nestedVerifyFixture('sq-3434-owned-');
  const { slug } = store.ensureProject(fixture.repository);
  const ticket = store.createTicket(slug, { title: 'nested verify fixture' });
  store.updateTicket(slug, ticket.ref, { executorVerify: fixture.command });
  try {
    const environment = { ...process.env, SIDEQUEST_JOB_AFFINITY_MASK: TWO_CORE_AFFINITY_MASK };
    const capture = await runVerifyCapture(fixture.command, fixture.repository, FIXTURE_DEADLINE_MILLISECONDS, environment);
    const grandchild = await fixture.grandchild();
    const sleeperPid = await fixture.sleeperPid();

    assert.equal(classifyProcessState(grandchild.pid), 'gone', 'the detached grandchild outlived the settled capture');
    assert.equal(classifyProcessState(sleeperPid), 'gone', 'the node sleeper outlived the settled capture');
    assert.equal(capture.status, 'timeout');
    assert.equal(capture.exitCode, 2);
    assert.match(capture.reason, /^Verification timed out after 5000ms\. The Windows job owner ended processes [\d, ]+; none survived\. Output log: /);
    assert.ok(capture.reason.endsWith(`Output log: ${capture.logPath}`), capture.reason);
    for (const processId of [sleeperPid, grandchild.pid]) {
      assert.ok(capture.reason.includes(String(processId)), `the cleanup evidence omits job member ${processId}: ${capture.reason}`);
    }
    // The command's cmd.exe ended with the job too: every member the job closed over is gone.
    const memberIds = capture.reason.match(/ended processes ([\d, ]+);/)[1].split(', ').map(Number);
    assert.ok(memberIds.length >= 3, `expected cmd, the sleeper and the grandchild, got ${memberIds}`);
    for (const processId of memberIds) assert.equal(classifyProcessState(processId), 'gone', `job member ${processId} survived settlement`);
    assert.ok(grandchild.parallelism <= 2, `the job tree saw ${grandchild.parallelism} processors under a two-core affinity mask`);
    assert.match(fs.readFileSync(capture.logPath, 'utf8'), /sleeper started/);

    const recorded = recordCapture({ project: fixture.repository, ticket: ticket.ref }, capture, fixture.repository);
    assert.equal(recorded.ok, true, JSON.stringify(recorded));
    const captures = store.getTicket(slug, ticket.ref).verificationCaptures;
    assert.equal(captures.at(-1).status, 'timeout');
    assert.equal(captures.at(-1).logPath, capture.logPath);
    fs.rmSync(capture.logPath, { force: true });
  } finally {
    await fixture.cleanup();
  }
});

test('control: the synchronous pre-job runner leaves the detached grandchild of a timed-out verify alive', { ...windowsOnly, timeout: 120_000 }, async () => {
  const fixture = nestedVerifyFixture('sq-3434-control-');
  try {
    const result = runProcessVerification(
      { kind: 'command', command: fixture.command, evidenceContract: 'command output' },
      { cwd: fixture.repository, timeoutMilliseconds: FIXTURE_DEADLINE_MILLISECONDS },
    );
    const grandchild = await fixture.grandchild();
    assert.equal(result.status, 'timeout');
    assert.equal(classifyProcessState(grandchild.pid), 'live', 'the pre-job runner unexpectedly ended the detached grandchild');
    fs.rmSync(result.logPath, { force: true });
  } finally {
    await fixture.cleanup();
  }
});

test('caller cancellation ends the whole verify tree and reports it as a cancelled run', { ...windowsOnly, timeout: 120_000 }, async () => {
  const fixture = nestedVerifyFixture('sq-3434-cancel-');
  const controller = new AbortController();
  try {
    const running = runOwnedProcessVerification(
      { kind: 'command', command: fixture.command, evidenceContract: 'command output' },
      { cwd: fixture.repository, timeoutMilliseconds: 60_000, signal: controller.signal },
    );
    const grandchild = await fixture.grandchild();
    controller.abort();
    const result = await running;

    assert.equal(result.status, 'could_not_run');
    assert.match(result.evidence, /^Verification was cancelled\. The Windows job owner ended processes [\d, ]+; none survived\. Output log: /);
    assert.equal(await stateAfterSettling(grandchild.pid), 'gone');
    assert.equal(await stateAfterSettling(await fixture.sleeperPid()), 'gone');
    fs.rmSync(result.logPath, { force: true });
  } finally {
    await fixture.cleanup();
  }
});

test('an already-cancelled caller starts nothing and gets a could_not_run result', windowsOnly, async () => {
  const result = await runOwnedProcessVerification(
    { kind: 'command', command: 'node --version', evidenceContract: 'command output' },
    { signal: AbortSignal.abort(new Error('caller gave up first')) },
  );
  assert.equal(result.status, 'could_not_run');
  assert.equal(result.evidence, 'caller gave up first');
  assert.equal(fs.readFileSync(result.logPath, 'utf8'), '');
  fs.rmSync(result.logPath, { force: true });
});

test('an owner killed before it can account for its job still takes the whole job down, and the phase reports survivor state unknown', { ...windowsOnly, timeout: 120_000 }, async (context: TestContext) => {
  const fixture = nestedVerifyFixture('sq-3456-hard-kill-');
  const runOwnedPhase = runnerWhoseOwnerIgnoresExitRequests(context);
  try {
    const result = await runOwnedPhase({
      command: process.execPath,
      args: fixture.sleeperArguments,
      cwd: fixture.repository,
      env: process.env,
      timeoutMilliseconds: FIXTURE_DEADLINE_MILLISECONDS,
      terminationGraceMilliseconds: 100,
      forwardStdout() {},
      forwardStderr() {},
    });
    const grandchild = await fixture.grandchild();
    assert.equal(result.timedOut, true);
    assert.equal(result.jobClosedProcessIds, null, 'a hard-killed owner cannot have accounted for its job');
    assert.equal(result.cleanupError, 'Survivor state unknown: the job owner left no account of its job members.');
    assert.equal(await stateAfterSettling(grandchild.pid), 'gone', 'the detached grandchild outlived the hard-killed owner');
    assert.equal(await stateAfterSettling(await fixture.sleeperPid()), 'gone', 'the node sleeper outlived the hard-killed owner');
  } finally {
    await fixture.cleanup();
  }
});

test('a capture whose owner left no account of its job says survivor state unknown, never none survived', async (context: TestContext) => {
  const ownedProcessTree = require('../scripts/owned-process-tree.js');
  context.mock.method(ownedProcessTree, 'runOwnedPhase', async () => ({
    status: null,
    signal: null,
    error: null,
    timedOut: true,
    cleanupError: 'Survivor state unknown: QueryInformationJobObject failed with Win32 error 6.',
    jobClosedProcessIds: null,
  }));
  const result = await runOwnedProcessVerification(
    { kind: 'command', command: 'node --version', evidenceContract: 'command output' },
    { timeoutMilliseconds: 1234 },
  );
  assert.equal(result.status, 'timeout');
  assert.match(result.evidence, /^Verification timed out after 1234ms\. Survivor state unknown: QueryInformationJobObject failed with Win32 error 6\. Output log: /);
  assert.doesNotMatch(result.evidence, /none survived/);
  fs.rmSync(result.logPath, { force: true });
});

test('a host without the Windows csc.exe fails loudly instead of running unowned', () => {
  const ownerPath = path.join(os.tmpdir(), `sq-3434-missing-compiler-${process.pid}`, 'owner.exe');
  assert.throws(() => compileJobOwner(ownerPath, null), (error: Error & { code?: string }) => {
    assert.equal(error.code, 'JOB_OWNER_UNAVAILABLE');
    assert.match(error.message, /csc\.exe that ships with Windows was not found/);
    return true;
  });
});

test('a compiler that rejects the owner source leaves no staged build behind', () => {
  const ownerDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-3434-bad-compiler-'));
  try {
    assert.throws(() => compileJobOwner(path.join(ownerDirectory, 'owner.exe'), process.execPath), /could not compile/);
    assert.deepEqual(fs.readdirSync(ownerDirectory), []);
  } finally {
    fs.rmSync(ownerDirectory, { recursive: true, force: true });
  }
});
