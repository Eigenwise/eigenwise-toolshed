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
const { classifyProcessState, compileJobOwner, withJobEvidence } = require('../scripts/owned-process-tree.js');
const store = require('../lib/store.js');

const windowsOnly = process.platform === 'win32' ? {} : { skip: 'Windows Job Objects' };
const FIXTURE_DEADLINE_MILLISECONDS = 5000;
const SETTLED_BUDGET_MILLISECONDS = 5000;
// At most two processors for the fixture tree, enforced by the job and read back from inside it.
const TWO_CORE_AFFINITY_MASK = '3';
const BROKER_BOUNDARY = 'Processes created through a broker (a service, COM activation, a daemon such as dockerd) are outside the job and are not tracked.';
const WINDOWS_JOB_ENDED_EVIDENCE = String.raw`The Windows job owner ended every descendant that inherited the job \(processes [\d, ]+\); none survived\. Processes created through a broker \(a service, COM activation, a daemon such as dockerd\) are outside the job and are not tracked\.`;

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

// Re-requires the runner behind a spy on the owner's spawn, which hands the test (never the phase) the
// owner's own arguments before it starts. An owner whose exit requests are lost ends only through the
// SIGKILL escalation, and dies without accounting for its job.
function runnerWithOwnerSpy(context: TestContext, ignoreExitRequests: boolean, beforeOwnerSpawn: (ownerArguments: string[]) => void = () => {}) {
  const childProcesses: typeof import('node:child_process') = require('node:child_process');
  const spawnOwner = childProcesses.spawn;
  context.mock.method(childProcesses, 'spawn', (command: string, argumentsList: string[], options: SpawnOptions) => {
    beforeOwnerSpawn(argumentsList);
    const owner = spawnOwner(command, argumentsList, options);
    if (ignoreExitRequests) context.mock.method(owner.stdin!, 'end', () => owner.stdin);
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
    assert.match(capture.reason, new RegExp(`^Verification timed out after 5000ms\\. ${WINDOWS_JOB_ENDED_EVIDENCE} Output log: `));
    assert.ok(capture.reason.endsWith(`Output log: ${capture.logPath}`), capture.reason);
    for (const processId of [sleeperPid, grandchild.pid]) {
      assert.ok(capture.reason.includes(String(processId)), `the cleanup evidence omits job member ${processId}: ${capture.reason}`);
    }
    // The command's cmd.exe ended with the job too: every member the job closed over is gone.
    const memberIds = capture.reason.match(/\(processes ([\d, ]+)\);/)[1].split(', ').map(Number);
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
    assert.match(result.evidence, new RegExp(`^Verification was cancelled\\. ${WINDOWS_JOB_ENDED_EVIDENCE} Output log: `));
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
  const runOwnedPhase = runnerWithOwnerSpy(context, true);
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

// The phase learns the real report path from SIDEQUEST_JOB_OWNER_REPORT if it inherited one, else from
// a file the test fills in from the owner's arguments, standing in for any way a phase could find it
// (SQ-3490). It writes only to a path named like a job report.
test('SQ-3490: a phase that writes "members 0 end" into its real job report cannot pass a hard-killed owner off as an empty job', { ...windowsOnly, timeout: 120_000 }, async (context: TestContext) => {
  const evidence = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-3490-forged-members-'));
  const reportPathHandoff = path.join(evidence, 'report.path');
  const forgedMarker = path.join(evidence, 'forged');
  const forger = path.join(evidence, 'forger.js');
  fs.writeFileSync(forger, [
    "const fs = require('node:fs');",
    "const reportPath = process.env.SIDEQUEST_JOB_OWNER_REPORT || fs.readFileSync(process.argv[2], 'utf8');",
    'if (/sidequest-job-[^\\\\/]*\\.log$/.test(reportPath)) {',
    "  fs.appendFileSync(reportPath, 'members 0 end\\n');",
    "  fs.writeFileSync(process.argv[3], '');",
    '}',
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n'));
  const runOwnedPhase = runnerWithOwnerSpy(context, true, ([reportPath]) => fs.writeFileSync(reportPathHandoff, reportPath));
  try {
    const result = await runOwnedPhase({
      command: process.execPath,
      args: [forger, reportPathHandoff, forgedMarker],
      cwd: evidence,
      env: process.env,
      timeoutMilliseconds: FIXTURE_DEADLINE_MILLISECONDS,
      terminationGraceMilliseconds: 100,
      forwardStdout() {},
      forwardStderr() {},
    });
    assert.equal(fs.existsSync(forgedMarker), true, 'the phase wrote its forged record into the real report');
    assert.equal(result.timedOut, true);
    assert.equal(result.jobClosedProcessIds, null, 'the forged record was read as the job account');
    assert.equal(result.cleanupError, 'Survivor state unknown: the job owner left no account of its job members.');
  } finally {
    fs.rmSync(evidence, { recursive: true, force: true });
  }
});

test('SQ-3490: the job owner hands its phase neither its report path, its nonce nor an inherited SIDEQUEST_JOB_OWNER_REPORT', { ...windowsOnly, timeout: 120_000 }, async (context: TestContext) => {
  let ownerArguments: string[] = [];
  const runOwnedPhase = runnerWithOwnerSpy(context, false, (argumentsList) => { ownerArguments = argumentsList; });
  let printed = '';
  const result = await runOwnedPhase({
    command: process.execPath,
    args: ['-e', 'process.stdout.write(JSON.stringify({ argv: process.argv, env: process.env }))'],
    cwd: os.tmpdir(),
    env: { ...process.env, SIDEQUEST_JOB_OWNER_REPORT: 'inherited-owner-report.log' },
    timeoutMilliseconds: 20_000,
    terminationGraceMilliseconds: 100,
    forwardStdout(chunk) { printed += chunk.toString('utf8'); },
    forwardStderr() {},
  });
  const [reportPath = '', nonce = ''] = ownerArguments;
  assert.ok(reportPath !== '' && nonce !== '', 'the owner was spawned with its report path and nonce');
  const phase = JSON.parse(printed);
  const visibleToPhase = [...phase.argv, ...Object.values(phase.env)].join('\n');

  assert.equal(result.cleanupError, null, 'the owner accounted for its job on the argument channel');
  assert.equal('SIDEQUEST_JOB_OWNER_REPORT' in phase.env, false, 'the phase inherited SIDEQUEST_JOB_OWNER_REPORT');
  assert.equal(visibleToPhase.includes(reportPath), false, 'the phase saw the report path');
  assert.equal(visibleToPhase.includes(nonce), false, 'the phase saw the nonce');
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

const REPORT_NONCE = 'c0ffee00-3490-4000-8000-000000000000';

// The owner starts every report line with the run's nonce.
function stamped(text: string, nonce = REPORT_NONCE) {
  return text.split('\n').map((line) => (line === '' ? line : `${nonce} ${line}`)).join('\n');
}

// Settles a timed-out phase against a job owner report holding exactly this text.
function jobEvidenceFromReport(text: string) {
  const reportPath = path.join(os.tmpdir(), `sq-3469-job-report-${process.pid}-${Math.random().toString(16).slice(2)}.log`);
  fs.writeFileSync(reportPath, text);
  return withJobEvidence({ status: null, signal: null, error: null, timedOut: true, cleanupError: null }, { reportPath, nonce: REPORT_NONCE }, 0);
}

// An owner killed while writing its account, or read before it finished, leaves any prefix of it (SQ-3466).
test('a members record cut off anywhere, or malformed, reports survivor state unknown, never an empty job', async () => {
  const completeReport = stamped('affinity 3\nrequested\nmembers 3 4120 9984 10236 end\n');
  const recordEnd = completeReport.indexOf(' end') + ' end'.length;
  const reviewPrefix = await jobEvidenceFromReport(stamped('affinity 3\nrequested\nmembers'));
  assert.deepEqual(
    { jobClosedProcessIds: reviewPrefix.jobClosedProcessIds, survivingProcessIds: reviewPrefix.survivingProcessIds, cleanupError: reviewPrefix.cleanupError },
    { jobClosedProcessIds: null, survivingProcessIds: null, cleanupError: "Survivor state unknown: the job owner's account of its job members was cut off or malformed." },
  );
  const incompleteReports = [
    ...Array.from({ length: recordEnd }, (_, length) => completeReport.slice(0, length)),
    ...['members 2 4120 end\n', 'members 1 41x0 end\n', 'members x end\n', 'members 1  4120 end\n', 'members 0\n'].map((report) => stamped(report)),
  ];
  const claimedAccounts = [];
  for (const report of incompleteReports) {
    const result = await jobEvidenceFromReport(report);
    if (result.jobClosedProcessIds !== null || result.survivingProcessIds !== null || !/^Survivor state unknown: /.test(result.cleanupError)) {
      claimedAccounts.push({ report, jobClosedProcessIds: result.jobClosedProcessIds, cleanupError: result.cleanupError });
    }
  }
  assert.deepEqual(claimedAccounts, [], 'an incomplete members record was read as the job account');
});

test('a whole members record is the job account, an empty one included', async () => {
  const listed = await jobEvidenceFromReport(stamped('affinity 3\nmembers 3 4120 9984 10236 end\n'));
  assert.deepEqual(listed.jobClosedProcessIds, [4120, 9984, 10236]);
  const empty = await jobEvidenceFromReport(stamped('affinity 3\nrequested\nmembers 0 end\n'));
  assert.deepEqual(
    { jobClosedProcessIds: empty.jobClosedProcessIds, survivingProcessIds: empty.survivingProcessIds, cleanupError: empty.cleanupError },
    { jobClosedProcessIds: [], survivingProcessIds: [], cleanupError: null },
  );
});

test('SQ-3490: a job report line without this run\'s nonce is no event, so an unstamped or foreign "members 0 end" is survivor state unknown', async () => {
  const forgedReports = [
    'members 0 end\n',
    stamped('members 0 end\n', 'f0e1d2c3-3490-4000-8000-000000000000'),
    `${stamped('affinity 3\n')}members 0 end\n`,
    `${stamped('affinity 3\n')}${REPORT_NONCE}members 0 end\n`,
  ];
  for (const report of forgedReports) {
    const result = await jobEvidenceFromReport(report);
    assert.deepEqual(
      { jobClosedProcessIds: result.jobClosedProcessIds, survivingProcessIds: result.survivingProcessIds, cleanupError: result.cleanupError },
      { jobClosedProcessIds: null, survivingProcessIds: null, cleanupError: 'Survivor state unknown: the job owner left no account of its job members.' },
      JSON.stringify(report),
    );
  }
});

test('a failed capture names what the Windows job ended and the broker boundary it cannot see past', async (context: TestContext) => {
  const ownedProcessTree = require('../scripts/owned-process-tree.js');
  const phases = [
    { jobClosedProcessIds: [], cleanupError: null },
    { jobClosedProcessIds: [41], cleanupError: 'Job members 41 were still alive after the job owner closed its job.' },
    { cleanupError: null },
  ];
  context.mock.method(ownedProcessTree, 'runOwnedPhase', async () => ({ status: null, signal: null, error: null, timedOut: true, ...phases.shift() }));
  const evidence = [];
  for (let run = 0; run < 3; run++) {
    const result = await runOwnedProcessVerification({ kind: 'command', command: 'node --version', evidenceContract: 'command output' }, { timeoutMilliseconds: 1234 });
    fs.rmSync(result.logPath, { force: true });
    evidence.push(result.evidence.replace(` Output log: ${result.logPath}`, ''));
  }
  assert.deepEqual(evidence, [
    `Verification timed out after 1234ms. The Windows job owner ended every descendant that inherited the job (none were still running); none survived. ${BROKER_BOUNDARY}`,
    `Verification timed out after 1234ms. The Windows job owner ended every descendant that inherited the job (processes 41); cleanup refused: Job members 41 were still alive after the job owner closed its job. ${BROKER_BOUNDARY}`,
    'Verification timed out after 1234ms. The owned process tree was ended; none survived.',
  ]);
});

test('a clean cache compiles the owner with the csc.exe that ships with Windows and publishes only the finished build', windowsOnly, () => {
  const ownerDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-3456-fresh-compile-'));
  const ownerPath = path.join(ownerDirectory, 'by-source-hash', 'sidequest-job-owner.exe');
  try {
    compileJobOwner(ownerPath);
    assert.deepEqual(fs.readdirSync(path.dirname(ownerPath)), ['sidequest-job-owner.exe'], 'the staged build was not renamed into place alone');
  } finally {
    fs.rmSync(ownerDirectory, { recursive: true, force: true });
  }
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
