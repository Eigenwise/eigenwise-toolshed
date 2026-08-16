import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

type ProcessState = 'gone' | 'zombie' | 'live';

interface OwnedTreeIdentity {
  ownerPid: number | null;
  ownedGroupId: number | null;
  phasePid: number | null;
}

interface OwnedPhaseOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMilliseconds?: number | null;
  retainedOutputBytes?: number;
  terminationGraceMilliseconds?: number;
  cleanupDrainMilliseconds?: number;
  supervisorModulePath?: string;
  forwardStdout?: (chunk: Buffer) => void;
  forwardStderr?: (chunk: Buffer) => void;
  onPhaseStarted?: (identity: OwnedTreeIdentity) => void;
}

interface OwnedPhaseResult {
  status: number | null;
  signal: string | null;
  error: (Error & { code?: string }) | null;
  timedOut: boolean;
  cleanupError: string | null;
  outputDrainTimedOut: boolean;
  durationMilliseconds: number;
  terminationLatencyMilliseconds: number | null;
  ownerPid: number | null;
  ownedGroupId: number | null;
  phasePid: number | null;
  unexpectedSignalErrorCode: string | null;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
}

const runnerModulePath = path.join(__dirname, '..', 'scripts', 'owned-process-tree.js');
// The runner is plain CommonJS with no declaration file, so its shape is stated once here
// instead of at every call site.
const ownedProcessTree = createRequire(__filename)(runnerModulePath) as {
  runOwnedPhase: (options: OwnedPhaseOptions) => Promise<OwnedPhaseResult>;
  classifyProcessState: (processId: number) => ProcessState;
  isProcessTerminal: (processId: number) => boolean;
};
const { runOwnedPhase, classifyProcessState, isProcessTerminal } = ownedProcessTree;

const runsOnWindows = process.platform === 'win32';
const posixOnly = runsOnWindows ? { skip: 'POSIX process groups' } : {};
const windowsOnly = runsOnWindows ? {} : { skip: 'Windows job objects' };

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-phase-'));
after(() => fs.rmSync(workspace, { recursive: true, force: true }));

function writeScript(name: string, source: string) {
  const scriptPath = path.join(workspace, name);
  fs.writeFileSync(scriptPath, source);
  return scriptPath;
}

function workspacePath(name: string) {
  return path.join(workspace, name);
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requireProcessId(processId: number | null | undefined, what: string) {
  if (typeof processId !== 'number') throw new Error(`${what} never reported a process id`);
  return processId;
}

async function waitUntilTerminal(processId: number, budgetMilliseconds: number) {
  const deadline = Date.now() + budgetMilliseconds;
  let state = classifyProcessState(processId);
  while (state === 'live' && Date.now() < deadline) {
    await delay(20);
    state = classifyProcessState(processId);
  }
  return state;
}

async function assertTerminalWithin(processId: number, budgetMilliseconds: number, subject: string) {
  const state = await waitUntilTerminal(processId, budgetMilliseconds);
  assert.notEqual(state, 'live', `${subject} (process ${processId}) was still live after ${budgetMilliseconds}ms`);
  return state;
}

function isGroupProbeable(groupId: number) {
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function silently(options: OwnedPhaseOptions): OwnedPhaseOptions {
  return { forwardStdout: () => {}, forwardStderr: () => {}, ...options };
}

const helloScript = writeScript(
  'hello.js',
  "process.stdout.write('phase stdout\\n');\nprocess.stderr.write('phase stderr\\n');\n",
);
const exitWithScript = writeScript('exit-with.js', 'process.exit(Number(process.argv[2]));\n');
const selfSignalScript = writeScript(
  'self-signal.js',
  "setTimeout(() => {}, 5000);\nprocess.kill(process.pid, 'SIGTERM');\n",
);
const writeOutputScript = writeScript(
  'write-output.js',
  'const [stdoutBytes, stderrBytes] = process.argv.slice(2).map(Number);\n'
    + "process.stdout.write('o'.repeat(stdoutBytes) + '\\n');\n"
    + "process.stderr.write('e'.repeat(stderrBytes) + '\\n');\n",
);
const termHandlerExitsZeroScript = writeScript(
  'term-handler-exits-zero.js',
  "process.on('SIGTERM', () => process.exit(0));\nsetInterval(() => {}, 1000);\nprocess.stdout.write('ready\\n');\n",
);
const termIgnoringSpinScript = writeScript(
  'term-ignoring-spin.js',
  "process.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\nprocess.stdout.write('ready\\n');\n",
);
const sleepScript = writeScript(
  'sleep.js',
  "setTimeout(() => process.exit(0), Number(process.argv[2]));\nprocess.stdout.write('ready\\n');\n",
);
const descendantScript = writeScript(
  'descendant.js',
  "const fs = require('node:fs');\n"
    + 'const [markerPath, delayMilliseconds, ignoreTerm] = process.argv.slice(2);\n'
    + "if (ignoreTerm === '1') process.on('SIGTERM', () => {});\n"
    + "setTimeout(() => { fs.writeFileSync(markerPath, 'descendant acted'); process.exit(0); }, Number(delayMilliseconds));\n",
);
const rootWithDescendantScript = writeScript(
  'root-with-descendant.js',
  "const { spawn } = require('node:child_process');\n"
    + "const fs = require('node:fs');\n"
    + 'const [descendantPidPath, markerPath, descendantDelay, ignoreTerm, rootLifetime] = process.argv.slice(2);\n'
    + `const descendant = spawn(process.execPath, [${JSON.stringify(descendantScript)}, markerPath, descendantDelay, ignoreTerm], { stdio: 'ignore', windowsHide: true });\n`
    + 'fs.writeFileSync(descendantPidPath, String(descendant.pid));\n'
    + 'descendant.unref();\n'
    + "process.stdout.write('ready\\n');\n"
    + "if (rootLifetime === 'spin') setInterval(() => {}, 1000);\n"
    + "else { const exitDelay = rootLifetime.startsWith('until:') ? Math.max(0, Number(rootLifetime.slice(6)) - Date.now()) : Number(rootLifetime); setTimeout(() => process.exit(0), exitDelay); }\n",
);
const rootWithSessionDetachedDescendantScript = writeScript(
  'root-with-session-detached-descendant.js',
  "const { spawn } = require('node:child_process');\n"
    + "const fs = require('node:fs');\n"
    + 'const [descendantPidPath, markerPath] = process.argv.slice(2);\n'
    + `const descendant = spawn(process.execPath, [${JSON.stringify(descendantScript)}, markerPath, '500', '0'], { detached: true, stdio: 'ignore', windowsHide: true });\n`
    + 'fs.writeFileSync(descendantPidPath, String(descendant.pid));\n'
    + 'descendant.unref();\n',
);

const delayedStartSupervisorScript = writeScript(
  'delayed-start-supervisor.js',
  `const { spawn } = require('node:child_process');
let cleanupStarted = false;
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => {});
function cleanup(terminationGraceMilliseconds) {
  if (cleanupStarted) return;
  cleanupStarted = true;
  process.kill(-process.pid, 'SIGTERM');
  setTimeout(() => process.kill(-process.pid, 'SIGKILL'), terminationGraceMilliseconds);
}
function reportPhaseError(error) {
  process.send({ type: 'phase-error', message: error.message, code: error.code ?? null, errno: error.errno ?? null, syscall: error.syscall ?? null, path: error.path ?? null });
}
function startDelayedPhase(request) {
  setTimeout(() => {
    if (cleanupStarted) return;
    const phase = spawn(request.command, request.args ?? [], {
      cwd: request.cwd ?? undefined,
      env: request.env ?? undefined,
      stdio: ['ignore', 'inherit', 'inherit'],
      windowsHide: true,
    });
    phase.once('error', reportPhaseError);
    phase.once('exit', (status, signal) => process.send({ type: 'phase-exit', status, signal }));
    process.send({ type: 'phase-started', pid: phase.pid });
  }, 600);
}
process.on('message', (message) => {
  if (message?.type === 'start') startDelayedPhase(message);
  else if (message?.type === 'cleanup') cleanup(message.terminationGraceMilliseconds ?? 300);
});
process.on('disconnect', () => cleanup(300));
`,
);

interface DescendantFixture {
  args: string[];
  rootLifetime: number | 'spin' | `until:${number}`;
  descendantPid: () => number;
  markerWritten: () => boolean;
}

let descendantFixtureCount = 0;

function descendantFixture(descendantDelayMilliseconds: number, ignoresTerm: boolean, rootLifetime: number | 'spin' | `until:${number}`): DescendantFixture {
  descendantFixtureCount += 1;
  const descendantPidPath = workspacePath(`descendant-${descendantFixtureCount}.pid`);
  const markerPath = workspacePath(`descendant-${descendantFixtureCount}.marker`);
  return {
    args: [
      rootWithDescendantScript,
      descendantPidPath,
      markerPath,
      String(descendantDelayMilliseconds),
      ignoresTerm ? '1' : '0',
      String(rootLifetime),
    ],
    rootLifetime,
    descendantPid: () => {
      assert.equal(fs.existsSync(descendantPidPath), true, 'the phase root never reported its descendant, so this row proves nothing');
      return Number(fs.readFileSync(descendantPidPath, 'utf8'));
    },
    markerWritten: () => fs.existsSync(markerPath),
  };
}

test('an owned phase reports its root status and forwards output with no control frames on its streams', async () => {
  const result = await runOwnedPhase(silently({ command: process.execPath, args: [helloScript], timeoutMilliseconds: 20_000 }));

  assert.equal(result.error, null);
  assert.equal(result.timedOut, false);
  assert.equal(result.cleanupError, null);
  assert.equal(result.status, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, 'phase stdout\n');
  assert.equal(result.stderr, 'phase stderr\n');
});

test('an owned phase preserves a non-zero root exit status', async () => {
  const result = await runOwnedPhase(silently({ command: process.execPath, args: [exitWithScript, '17'], timeoutMilliseconds: 20_000 }));

  assert.equal(result.status, 17);
  assert.equal(result.signal, null);
  assert.equal(result.timedOut, false);
  assert.equal(result.cleanupError, null);
});

test('a missing phase command surfaces as a spawn error with no status', async () => {
  const result = await runOwnedPhase(silently({ command: 'sidequest-no-such-executable-sq2054', timeoutMilliseconds: 20_000 }));

  assert.equal(result.error?.code, 'ENOENT');
  assert.equal(result.status, null);
  assert.equal(result.timedOut, false);
});

test('the supervisor control protocol accepts only its finite transitions', { ...posixOnly, timeout: 60_000 }, async () => {
  const validStart = { type: 'phase-started', pid: 12345 };
  const validExit = { type: 'phase-exit', status: 0, signal: null };
  const validError = {
    type: 'phase-error',
    message: 'spawn failed',
    code: 'ENOENT',
    errno: null,
    syscall: null,
    path: null,
  };
  const validSignalError = { type: 'signal-error', signal: 'SIGTERM', code: 'EPERM' };
  const validNullSignalError = { type: 'signal-error', signal: 'SIGTERM', code: null };
  const validKillSignalError = { type: 'signal-error', signal: 'SIGKILL', code: 'EPERM' };
  const cases = [
    { name: 'exit-before-start', frames: [validExit], errorCode: 'EPROTO' },
    { name: 'signal-before-start', frames: [validSignalError], errorCode: 'EPROTO' },
    { name: 'null-frame', frames: [null], errorCode: 'EPROTO' },
    { name: 'array-frame', frames: [[]], errorCode: 'EPROTO' },
    { name: 'primitive-frame', frames: [7], errorCode: 'EPROTO' },
    { name: 'incomplete-frame', frames: [{ type: 'phase-error', message: 'missing fields' }], errorCode: 'EPROTO' },
    { name: 'duplicate-start', frames: [validStart, validStart], errorCode: 'EPROTO' },
    { name: 'signal-while-running', frames: [validStart, validSignalError], errorCode: 'EPROTO' },
    { name: 'duplicate-exit', frames: [validStart, validExit, validExit], errorCode: 'EPROTO' },
    { name: 'contradictory-exit-error', frames: [validStart, validExit, validError], errorCode: 'EPROTO' },
    { name: 'start-after-terminal', frames: [validStart, validExit, validStart], errorCode: 'EPROTO' },
    { name: 'malformed-start', frames: [{ type: 'phase-started', pid: '12345' }], errorCode: 'EPROTO' },
    { name: 'malformed-exit', frames: [validStart, { type: 'phase-exit', status: 0 }], errorCode: 'EPROTO' },
    { name: 'malformed-error', frames: [validStart, { type: 'phase-error', message: 1 }], errorCode: 'EPROTO' },
    { name: 'invalid-signal-shape', frames: [validStart, validExit, { type: 'signal-error', signal: 7, code: null }], errorCode: 'EPROTO' },
    { name: 'unexpected-signal', frames: [validStart, validExit, validKillSignalError], errorCode: 'EPROTO' },
    { name: 'duplicate-signal', frames: [validStart, validExit, validSignalError, validSignalError], errorCode: 'EPROTO' },
    { name: 'signal-after-protocol-failure', frames: [validStart, { type: 'signal-error', signal: 7, code: null }, validSignalError], errorCode: 'EPROTO' },
    { name: 'valid-start-exit', frames: [validStart, validExit], errorCode: null },
    { name: 'valid-cleanup-signal-error', frames: [validStart, validExit, validSignalError], errorCode: null, cleanupError: 'SIGTERM.*EPERM' },
    { name: 'valid-null-code-cleanup-signal-error', frames: [validStart, validExit, validNullSignalError], errorCode: null, cleanupError: 'SIGTERM' },
    { name: 'valid-two-cleanup-signal-errors', frames: [validStart, validExit, validSignalError, validKillSignalError], errorCode: null, cleanupError: 'SIGKILL.*EPERM' },
    { name: 'valid-start-failure', frames: [validError], errorCode: 'ENOENT' },
  ];

  for (const protocolCase of cases) {
    const supervisorModulePath = writeScript(
      `supervisor-protocol-${protocolCase.name}.js`,
      `process.once('message', () => { for (const frame of ${JSON.stringify(protocolCase.frames)}) process.send(frame); setInterval(() => {}, 1000); });\n`,
    );
    const result = await runOwnedPhase(silently({
      command: process.execPath,
      args: [helloScript],
      timeoutMilliseconds: 20_000,
      terminationGraceMilliseconds: 100,
      cleanupDrainMilliseconds: 250,
      supervisorModulePath,
    }));

    assert.equal(result.error?.code ?? null, protocolCase.errorCode, protocolCase.name);
    if ('cleanupError' in protocolCase && typeof protocolCase.cleanupError === 'string') {
      assert.match(result.cleanupError ?? '', new RegExp(protocolCase.cleanupError), protocolCase.name);
    }
    assert.equal(result.timedOut, false, protocolCase.name);
    assert.ok(result.durationMilliseconds < 1500, `${protocolCase.name} settled after ${result.durationMilliseconds}ms`);
  }
});

test('the node 22 protocol alphabet rejects every length-three sequence except phase-started then phase-exit', { ...posixOnly, timeout: 180_000 }, async () => {
  const frames = [
    { type: 'phase-started', pid: 12345 },
    { type: 'phase-exit', status: 0, signal: null },
    { type: 'phase-error', message: 'spawn failed', code: 'ENOENT', errno: null, syscall: null, path: null },
    { type: 'signal-error', signal: 'SIGTERM', code: 'EPERM' },
    { type: 'signal-error', signal: 7, code: null },
    { type: 'phase-started', pid: '12345' },
    { type: 'phase-exit', status: 0 },
    { type: 'phase-error', message: 1 },
    { type: 'signal-error', signal: 'SIGKILL', code: 'EPERM' },
    { type: 'unexpected' },
    null,
    [],
  ];
  const sequences: unknown[][] = [[]];
  for (let length = 1; length <= 3; length += 1) {
    const previousSequences = sequences.filter((sequence) => sequence.length === length - 1);
    for (const sequence of previousSequences) {
      for (const frame of frames) sequences.push([...sequence, frame]);
    }
  }
  assert.equal(sequences.length, 1885);

  const runSequence = async (sequence: unknown[], index: number) => {
    const supervisorModulePath = writeScript(
      `supervisor-exhaustive-${index}.js`,
      sequence.length === 0
        ? "process.once('message', () => process.exit(0));\n"
        : `process.on('message', (message) => { if (message.type === 'start') { for (const frame of ${JSON.stringify(sequence)}) process.send(frame); } else process.exit(0); }); setInterval(() => {}, 1000);\n`,
    );
    const result = await runOwnedPhase(silently({
      command: process.execPath,
      args: [helloScript],
      timeoutMilliseconds: 20_000,
      terminationGraceMilliseconds: 25,
      cleanupDrainMilliseconds: 50,
      supervisorModulePath,
    }));
    const isOnlyGreenSequence = sequence.length === 2 && sequence[0] === frames[0] && sequence[1] === frames[1];
    const isGreen = result.status === 0 && result.error === null && result.cleanupError === null && result.timedOut === false;
    assert.equal(isGreen, isOnlyGreenSequence, `sequence ${index} unexpectedly ${isGreen ? 'passed' : 'failed'}`);
  };

  const parallelism = 16;
  for (let index = 0; index < sequences.length; index += parallelism) {
    await Promise.all(sequences.slice(index, index + parallelism).map((sequence, offset) => runSequence(sequence, index + offset)));
  }
});

test('a pre-start terminal result is a protocol failure and terminates its owner', { ...posixOnly, timeout: 60_000 }, async () => {
  const supervisorModulePath = writeScript(
    'supervisor-pre-start-exit.js',
    "process.once('message', () => { process.send({ type: 'phase-exit', status: 0, signal: null }); setInterval(() => {}, 1000); });\n",
  );
  const result = await runOwnedPhase(silently({
    command: process.execPath,
    args: [helloScript],
    timeoutMilliseconds: 20_000,
    terminationGraceMilliseconds: 100,
    cleanupDrainMilliseconds: 250,
    supervisorModulePath,
  }));

  assert.equal(result.error?.code, 'EPROTO');
  assert.equal(result.status, null);
  await assertTerminalWithin(requireProcessId(result.ownerPid, 'protocol owner'), 1000, 'protocol owner');
});

test('the node 22 control probe rejects a pre-start terminal frame', () => {
  const supervisorModulePath = writeScript(
    'supervisor-control-probe.js',
    "process.on('message', (message) => { if (message.type === 'start') process.send({ type: 'phase-exit', status: 0, signal: null }); else process.exit(0); });\n",
  );
  const forcePosixOwnership = runsOnWindows ? "Object.defineProperty(process, 'platform', { value: 'linux' });" : '';
  const probeSource = `${forcePosixOwnership}const { runOwnedPhase } = require(${JSON.stringify(runnerModulePath)}); runOwnedPhase({ command: process.execPath, args: [${JSON.stringify(helloScript)}], timeoutMilliseconds: 1000, terminationGraceMilliseconds: 50, cleanupDrainMilliseconds: 100, supervisorModulePath: ${JSON.stringify(supervisorModulePath)}, forwardStdout() {}, forwardStderr() {} }).then((result) => process.stdout.write(JSON.stringify({ error: result.error?.code ?? null, status: result.status, timedOut: result.timedOut })));`;
  const probe = spawnSync(process.execPath, ['-e', probeSource], { encoding: 'utf8', timeout: 5_000, windowsHide: true });

  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(JSON.parse(probe.stdout), { error: 'EPROTO', status: null, timedOut: false });
});

test('the node 22 cleanup signal probe turns an otherwise zero exit into a cleanup failure', () => {
  const supervisorModulePath = writeScript(
    'supervisor-cleanup-signal-probe.js',
    "process.on('message', (message) => { if (message.type === 'start') { process.send({ type: 'phase-started', pid: 12345 }); process.send({ type: 'phase-exit', status: 0, signal: null }); process.send({ type: 'signal-error', signal: 'SIGTERM', code: 'EPERM' }); } else process.exit(0); });\n",
  );
  const forcePosixOwnership = runsOnWindows ? "Object.defineProperty(process, 'platform', { value: 'linux' });" : '';
  const probeSource = `${forcePosixOwnership}const { runOwnedPhase } = require(${JSON.stringify(runnerModulePath)}); runOwnedPhase({ command: process.execPath, args: [${JSON.stringify(helloScript)}], timeoutMilliseconds: 1000, terminationGraceMilliseconds: 50, cleanupDrainMilliseconds: 100, supervisorModulePath: ${JSON.stringify(supervisorModulePath)}, forwardStdout() {}, forwardStderr() {} }).then((result) => process.stdout.write(JSON.stringify({ error: result.error?.code ?? null, status: result.status, timedOut: result.timedOut, cleanupError: result.cleanupError })));`;
  const probe = spawnSync(process.execPath, ['-e', probeSource], { encoding: 'utf8', timeout: 5_000, windowsHide: true });

  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(JSON.parse(probe.stdout), {
    error: null,
    status: 0,
    timedOut: false,
    cleanupError: 'The phase owner could not send SIGTERM to its owned process group: EPERM.',
  });
});

test('malformed control data after owner exit or timeout still cannot produce a green result', { ...posixOnly, timeout: 60_000 }, async () => {
  const ownerExitSupervisor = writeScript(
    'supervisor-owner-exit-race.js',
    "process.once('message', () => { process.send({ type: 'phase-started', pid: 12345 }); process.send({ type: 'phase-exit', status: 0 }); process.exit(0); });\n",
  );
  const ownerExitResult = await runOwnedPhase(silently({
    command: process.execPath,
    args: [helloScript],
    timeoutMilliseconds: 20_000,
    terminationGraceMilliseconds: 100,
    cleanupDrainMilliseconds: 250,
    supervisorModulePath: ownerExitSupervisor,
  }));
  assert.equal(ownerExitResult.error?.code, 'EPROTO');

  const timeoutSupervisor = writeScript(
    'supervisor-timeout-race.js',
    "process.on('message', (message) => { if (message.type === 'start') process.send({ type: 'phase-started', pid: 12345 }); else process.send({ type: 'phase-exit', status: 0 }); }); setInterval(() => {}, 1000);\n",
  );
  const timeoutResult = await runOwnedPhase(silently({
    command: process.execPath,
    args: [helloScript],
    timeoutMilliseconds: 20,
    terminationGraceMilliseconds: 100,
    cleanupDrainMilliseconds: 250,
    supervisorModulePath: timeoutSupervisor,
  }));
  assert.equal(timeoutResult.error?.code, 'EPROTO');
  assert.equal(timeoutResult.timedOut, true);
});

test('a node 22 exact-deadline control probe accepts the delayed exit of an already-started phase', () => {
  const supervisorModulePath = writeScript(
    'supervisor-delayed-timeout-exit.js',
    "process.on('message', (message) => { if (message.type === 'start') process.send({ type: 'phase-started', pid: 12345 }); else if (message.type === 'cleanup') setTimeout(() => { process.send({ type: 'phase-exit', status: null, signal: 'SIGTERM' }); process.exit(0); }, 10); });\n",
  );
  const forcePosixOwnership = runsOnWindows ? "Object.defineProperty(process, 'platform', { value: 'linux' });" : '';
  const probeSource = `${forcePosixOwnership}const { runOwnedPhase } = require(${JSON.stringify(runnerModulePath)}); runOwnedPhase({ command: process.execPath, args: [${JSON.stringify(helloScript)}], timeoutMilliseconds: 200, terminationGraceMilliseconds: 50, cleanupDrainMilliseconds: 100, supervisorModulePath: ${JSON.stringify(supervisorModulePath)}, forwardStdout() {}, forwardStderr() {} }).then((result) => process.stdout.write(JSON.stringify({ error: result.error?.code ?? null, status: result.status, signal: result.signal, timedOut: result.timedOut })));`;
  const probe = spawnSync(process.execPath, ['-e', probeSource], { encoding: 'utf8', timeout: 5_000, windowsHide: true });

  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(JSON.parse(probe.stdout), { error: null, status: null, signal: 'SIGTERM', timedOut: true });
});

test('large phase output is forwarded whole while the retained tail stays bounded', async () => {
  let forwardedStdoutBytes = 0;
  let forwardedStderrBytes = 0;
  const result = await runOwnedPhase({
    command: process.execPath,
    args: [writeOutputScript, '200000', '100000'],
    timeoutMilliseconds: 30_000,
    retainedOutputBytes: 4096,
    forwardStdout: (chunk) => {
      forwardedStdoutBytes += chunk.length;
    },
    forwardStderr: (chunk) => {
      forwardedStderrBytes += chunk.length;
    },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdoutBytes, 200_001);
  assert.equal(result.stderrBytes, 100_001);
  assert.equal(forwardedStdoutBytes, result.stdoutBytes);
  assert.equal(forwardedStderrBytes, result.stderrBytes);
  assert.ok(Buffer.byteLength(result.stdout) <= 4096, `retained ${Buffer.byteLength(result.stdout)} stdout bytes`);
  assert.ok(Buffer.byteLength(result.stderr) <= 4096, `retained ${Buffer.byteLength(result.stderr)} stderr bytes`);
  assert.equal(result.stdout.endsWith('o\n'), true);
});

test('a deadline fails the phase and ends its tree before a delayed descendant can act', { timeout: 60_000 }, async () => {
  const fixture = descendantFixture(3000, false, 'spin');
  const result = await runOwnedPhase(silently({
    command: process.execPath,
    args: fixture.args,
    timeoutMilliseconds: 400,
    terminationGraceMilliseconds: 200,
    cleanupDrainMilliseconds: 300,
  }));

  assert.equal(result.timedOut, true);
  assert.equal(result.cleanupError, null);
  assert.ok(result.durationMilliseconds < 1600, `phase settled after ${result.durationMilliseconds}ms, past its 900ms bound`);
  await assertTerminalWithin(fixture.descendantPid(), 5000, 'the deadline-ended descendant');
  assert.equal(fixture.markerWritten(), false);
});

test('a phase whose root exits cleanly still takes a delayed descendant with it', { timeout: 60_000 }, async () => {
  const fixture = descendantFixture(3000, false, 200);
  const result = await runOwnedPhase(silently({
    command: process.execPath,
    args: fixture.args,
    timeoutMilliseconds: 20_000,
    terminationGraceMilliseconds: 200,
  }));

  assert.equal(result.status, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.cleanupError, null);
  await assertTerminalWithin(fixture.descendantPid(), 5000, 'the descendant of a successful phase');
  assert.equal(fixture.markerWritten(), false);
});

test('an owned phase leaves no exit listener, timer or channel holding the event loop open', { timeout: 60_000 }, async () => {
  const driverScript = writeScript(
    'cleanup-driver.js',
    `const { runOwnedPhase } = require(${JSON.stringify(runnerModulePath)});\n`
      + "const exitListenersBefore = process.listenerCount('exit');\n"
      + `runOwnedPhase({ command: process.execPath, args: [${JSON.stringify(helloScript)}], timeoutMilliseconds: 20000, forwardStdout: () => {}, forwardStderr: () => {} })\n`
      + '  .then((result) => {\n'
      + '    process.stdout.write(JSON.stringify({\n'
      + '      status: result.status,\n'
      + '      exitListenersBefore,\n'
      + "      exitListenersAfter: process.listenerCount('exit'),\n"
      + "      activeTimers: process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length,\n"
      + '    }));\n'
      + '  });\n',
  );

  // The driver never calls process.exit, so it can only end by running out of work. A
  // leaked timer, exit listener or IPC channel would hold it open past this watchdog.
  const driver = spawn(process.execPath, [driverScript], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  const watchdog = setTimeout(() => driver.kill('SIGKILL'), 20_000);
  let driverStdout = '';
  driver.stdout.on('data', (chunk: Buffer) => {
    driverStdout += chunk.toString('utf8');
  });
  const driverExit = await new Promise<{ status: number | null; signal: string | null }>((resolve) => {
    driver.once('exit', (status, signal) => resolve({ status, signal }));
  });
  clearTimeout(watchdog);

  assert.equal(driverExit.signal, null, 'the driver had to be killed, so the runner left the event loop open');
  assert.equal(driverExit.status, 0);
  const report = JSON.parse(driverStdout) as {
    status: number | null;
    exitListenersBefore: number;
    exitListenersAfter: number;
    activeTimers: number;
  };
  assert.equal(report.status, 0);
  assert.equal(report.exitListenersAfter, report.exitListenersBefore);
  assert.equal(report.activeTimers, 0);
});

test('an exact deadline starts after the owner reports its phase root', { ...posixOnly, timeout: 60_000 }, async () => {
  const sentinel = spawn(process.execPath, [sleepScript, '180000'], {
    stdio: 'ignore',
    detached: true,
    windowsHide: true,
  });
  sentinel.unref();
  const sentinelPid = requireProcessId(sentinel.pid, 'the unrelated sentinel');
  const fixture = descendantFixture(2000, false, 'spin');
  try {
    const result = await runOwnedPhase(silently({
      command: process.execPath,
      args: fixture.args,
      timeoutMilliseconds: 500,
      terminationGraceMilliseconds: 60,
      cleanupDrainMilliseconds: 200,
      supervisorModulePath: delayedStartSupervisorScript,
    }));

    assert.equal(result.error, null);
    assert.equal(result.timedOut, true);
    assert.equal(result.cleanupError, null);
    await assertTerminalWithin(fixture.descendantPid(), 5000, 'the delayed-start descendant');
    assert.equal(fixture.markerWritten(), false);
    assert.equal(classifyProcessState(sentinelPid), 'live');
  } finally {
    try {
      process.kill(sentinelPid, 'SIGKILL');
    } catch {
      // The sentinel assertion above already reported anything worth knowing.
    }
  }
});

test('100 exact-deadline races leave no descendant behind and spare an unrelated process', { timeout: 300_000 }, async () => {
  const sentinel = spawn(process.execPath, [sleepScript, '180000'], {
    stdio: 'ignore',
    detached: true,
    windowsHide: true,
  });
  sentinel.unref();
  const sentinelPid = requireProcessId(sentinel.pid, 'the unrelated sentinel');

  const rows: Array<{ timedOut: boolean; descendantPid: number; markerWritten: () => boolean }> = [];
  try {
    for (let row = 0; row < 100; row += 1) {
      const deadlineMilliseconds = 500;
      const fixture = descendantFixture(2000, false, 'spin');
      assert.equal(fixture.rootLifetime, 'spin', `row ${row} let its root exit before cleanup could prove descendant terminality`);
      const result = await runOwnedPhase(silently({
        command: process.execPath,
        args: fixture.args,
        timeoutMilliseconds: deadlineMilliseconds,
        terminationGraceMilliseconds: 60,
        cleanupDrainMilliseconds: 200,
      }));
      assert.equal(result.error, null, `row ${row} reported ${result.error?.message}`);
      assert.equal(result.cleanupError, null, `row ${row} reported ${result.cleanupError}`);
      assert.equal(result.unexpectedSignalErrorCode, null, `row ${row} hit signal error ${result.unexpectedSignalErrorCode}`);
      const descendantPid = fixture.descendantPid();
      // Prove terminality now, while this pid still unambiguously names this row's
      // descendant. Collecting all 100 pids and probing them afterwards left a ~50s
      // window in which the OS could recycle an exited descendant's pid onto an
      // unrelated live process, which then read as a leaked descendant and failed the
      // gate on unchanged code (SQ-2179).
      await assertTerminalWithin(descendantPid, 5000, `the descendant of race row ${row}`);
      rows.push({ timedOut: result.timedOut, descendantPid, markerWritten: fixture.markerWritten });
    }

    for (const [index, row] of rows.entries()) {
      assert.equal(row.markerWritten(), false, `row ${index} let its descendant act after the phase ended`);
    }
    assert.equal(rows.length, 100);
    assert.equal(classifyProcessState(sentinelPid), 'live');
  } finally {
    try {
      process.kill(sentinelPid, 'SIGKILL');
    } catch {
      // The sentinel assertion above already reported anything worth knowing.
    }
  }
});

test('the Windows deadline ends the owned tree through its live handle without helper latency', { ...windowsOnly, timeout: 60_000 }, async () => {
  const fixture = descendantFixture(3000, false, 'spin');
  const result = await runOwnedPhase(silently({
    command: process.execPath,
    args: fixture.args,
    timeoutMilliseconds: 400,
    terminationGraceMilliseconds: 200,
  }));

  assert.equal(result.timedOut, true);
  // "Through its live handle" is a claim about which code path ran, and the result says so
  // outright: only the directly-owned path reports no group id and makes the phase process its
  // own owner. The supervisor path always carries a group id. Asserting that beats timing it.
  assert.equal(result.ownedGroupId, null);
  assert.equal(typeof result.ownerPid, 'number');
  assert.equal(result.ownerPid, result.phasePid);
  // The bound is the grace window this phase was given, not a tuned number: staying inside it
  // means the handle close ended the tree on its own, with no escalation and no room for a
  // spawned terminator. The old sub-20ms bound measured runner load instead, and failed on
  // windows-latest against unchanged code (SQ-2179).
  assert.ok(
    (result.terminationLatencyMilliseconds ?? Infinity) < 200,
    `termination took ${result.terminationLatencyMilliseconds}ms, so the live handle did not end the tree within its grace window`,
  );
  assert.equal(await waitUntilTerminal(fixture.descendantPid(), 5000), 'gone');
  assert.equal(fixture.markerWritten(), false);
});

test('a deadline fails the phase even when the root handles SIGTERM and exits 0', { ...posixOnly, timeout: 60_000 }, async () => {
  const result = await runOwnedPhase(silently({
    command: process.execPath,
    args: [termHandlerExitsZeroScript],
    timeoutMilliseconds: 400,
    terminationGraceMilliseconds: 200,
    cleanupDrainMilliseconds: 300,
  }));

  // The root really does get to report 0 here, and that is the false green: a phase the
  // clock ended never ran its tests, so the deadline has to be the verdict on its own.
  assert.equal(result.timedOut, true);
  assert.equal(result.cleanupError, null);
  assert.ok(result.durationMilliseconds < 1600, `phase settled after ${result.durationMilliseconds}ms`);
});

test('a root that ignores SIGTERM is killed inside the phase bound', { ...posixOnly, timeout: 60_000 }, async () => {
  const result = await runOwnedPhase(silently({
    command: process.execPath,
    args: [termIgnoringSpinScript],
    timeoutMilliseconds: 200,
    terminationGraceMilliseconds: 200,
    cleanupDrainMilliseconds: 300,
  }));

  assert.equal(result.timedOut, true);
  assert.equal(result.cleanupError, null);
  assert.ok(result.durationMilliseconds < 1200, `phase settled after ${result.durationMilliseconds}ms, past its 700ms bound`);
  await assertTerminalWithin(requireProcessId(result.phasePid, 'the TERM-resistant root'), 5000, 'the TERM-resistant root');
});

test('a descendant that ignores SIGTERM is killed with the group', { ...posixOnly, timeout: 60_000 }, async () => {
  const fixture = descendantFixture(3000, true, 200);
  const result = await runOwnedPhase(silently({
    command: process.execPath,
    args: fixture.args,
    timeoutMilliseconds: 20_000,
    terminationGraceMilliseconds: 200,
    cleanupDrainMilliseconds: 300,
  }));

  assert.equal(result.status, 0);
  assert.equal(result.cleanupError, null);
  await assertTerminalWithin(fixture.descendantPid(), 5000, 'the TERM-resistant descendant');
  assert.equal(fixture.markerWritten(), false);
});

test('a self-signalled root reports its signal rather than a status', posixOnly, async () => {
  const result = await runOwnedPhase(silently({ command: process.execPath, args: [selfSignalScript], timeoutMilliseconds: 20_000 }));

  assert.equal(result.status, null);
  assert.equal(result.signal, 'SIGTERM');
  assert.equal(result.timedOut, false);
  assert.equal(result.cleanupError, null);
});

test('the owner keeps pinning its process group after the real root is gone', { ...posixOnly, timeout: 60_000 }, async () => {
  let reportIdentity: (identity: OwnedTreeIdentity) => void = () => {};
  const identityReported = new Promise<OwnedTreeIdentity>((resolve) => {
    reportIdentity = resolve;
  });
  const phase = runOwnedPhase(silently({
    command: process.execPath,
    args: [sleepScript, '80'],
    timeoutMilliseconds: 20_000,
    terminationGraceMilliseconds: 1500,
    onPhaseStarted: (identity) => reportIdentity(identity),
  }));

  const identity = await identityReported;
  const ownedGroupId = requireProcessId(identity.ownedGroupId, 'the phase owner');
  assert.equal(ownedGroupId, identity.ownerPid);
  await assertTerminalWithin(requireProcessId(identity.phasePid, 'the phase root'), 5000, 'the phase root');

  // The root is already gone and the sweep has not finished. Nothing but a live leader
  // stops the kernel handing this exact number to somebody else's brand new group.
  assert.equal(classifyProcessState(ownedGroupId), 'live');
  assert.equal(isGroupProbeable(ownedGroupId), true);

  const result = await phase;
  assert.equal(result.status, 0, 'the phase result must be flushed before cleanup destroys its owner');
  assert.equal(result.cleanupError, null);
  assert.equal(isProcessTerminal(ownedGroupId), true);
});

test('an unexpected owner exit ends the still-pinned live phase before settlement', { ...posixOnly, timeout: 60_000 }, async () => {
  const sentinel = spawn(process.execPath, [sleepScript, '30000'], {
    stdio: 'ignore',
    detached: true,
    windowsHide: true,
  });
  sentinel.unref();
  const sentinelPid = requireProcessId(sentinel.pid, 'the unrelated sentinel');

  try {
    let reportIdentity: (identity: OwnedTreeIdentity) => void = () => {};
    const identityReported = new Promise<OwnedTreeIdentity>((resolve) => {
      reportIdentity = resolve;
    });
    const phase = runOwnedPhase(silently({
      command: process.execPath,
      args: [termIgnoringSpinScript],
      timeoutMilliseconds: 25_000,
      terminationGraceMilliseconds: 200,
      cleanupDrainMilliseconds: 400,
      onPhaseStarted: (identity) => reportIdentity(identity),
    }));

    const identity = await identityReported;
    const phasePid = requireProcessId(identity.phasePid, 'the phase root');
    process.kill(requireProcessId(identity.ownerPid, 'the phase owner'), 'SIGKILL');
    const result = await phase;

    assert.match(result.cleanupError ?? '', /owner exited unexpectedly.*still-pinned process group was terminated/);
    assert.equal(result.timedOut, false);
    assert.notEqual(classifyProcessState(phasePid), 'live', 'the phase was still live after runOwnedPhase settled');
    assert.equal(classifyProcessState(sentinelPid), 'live', 'cleanup reached an unrelated process group');
    assert.ok(result.durationMilliseconds < 5000, `settled after ${result.durationMilliseconds}ms`);
  } finally {
    try {
      process.kill(sentinelPid, 'SIGKILL');
    } catch {
      // The assertions above already report any unexpected sentinel exit.
    }
  }
});

test('a descendant that deliberately starts a new POSIX session is outside portable ownership', { ...posixOnly, timeout: 60_000 }, async () => {
  const descendantPidPath = workspacePath('session-detached-descendant.pid');
  const markerPath = workspacePath('session-detached-descendant.marker');
  const result = await runOwnedPhase(silently({
    command: process.execPath,
    args: [rootWithSessionDetachedDescendantScript, descendantPidPath, markerPath],
    timeoutMilliseconds: 20_000,
    terminationGraceMilliseconds: 100,
    cleanupDrainMilliseconds: 250,
  }));

  assert.equal(result.status, 0);
  assert.equal(result.cleanupError, null);
  assert.equal(fs.existsSync(descendantPidPath), true, 'the detached descendant never started');
  await delay(800);
  assert.equal(fs.existsSync(markerPath), true, 'the deliberately detached descendant did not outlive group cleanup');
  await assertTerminalWithin(Number(fs.readFileSync(descendantPidPath, 'utf8')), 5000, 'the naturally exiting detached descendant');
});

test('an owner that cannot start is reported as a cleanup failure rather than a passing phase', posixOnly, async () => {
  const result = await runOwnedPhase(silently({
    command: process.execPath,
    args: [helloScript],
    timeoutMilliseconds: 20_000,
    supervisorModulePath: workspacePath('supervisor-that-does-not-exist.js'),
  }));

  assert.match(result.cleanupError ?? '', /owner exited unexpectedly/);
  assert.equal(result.status, null);
  assert.equal(result.timedOut, false);
  assert.ok(result.durationMilliseconds < 5000, `settled after ${result.durationMilliseconds}ms`);
});

test('a dead unreaped process reads as terminal while a runnable one reads as live', { ...posixOnly, timeout: 60_000 }, async () => {
  const zombiePidPath = workspacePath('zombie.pid');
  // exec replaces the shell without changing its pid, so the background job keeps a parent
  // that will never call wait(). It stays probeable by signal 0 and can never run another
  // instruction, which is exactly the state a naive kill(pid, 0) oracle misreads as live.
  const shell = spawn('sh', ['-c', `sleep 0.2 & echo $! > ${JSON.stringify(zombiePidPath)}; exec sleep 60`], {
    stdio: 'ignore',
    detached: true,
    windowsHide: true,
  });
  shell.unref();
  const shellPid = requireProcessId(shell.pid, 'the zombie-making shell');
  try {
    await delay(800);
    const zombiePid = Number(fs.readFileSync(zombiePidPath, 'utf8').trim());
    assert.equal(classifyProcessState(zombiePid), 'zombie');
    assert.equal(isProcessTerminal(zombiePid), true);
    assert.equal(classifyProcessState(shellPid), 'live');
    assert.equal(isProcessTerminal(shellPid), false);
  } finally {
    process.kill(shellPid, 'SIGKILL');
  }

  const reaped = spawn(process.execPath, [exitWithScript, '0'], { stdio: 'ignore', windowsHide: true });
  const reapedPid = requireProcessId(reaped.pid, 'the reaped control process');
  await new Promise((resolve) => reaped.once('exit', resolve));
  assert.equal(classifyProcessState(reapedPid), 'gone');
});
