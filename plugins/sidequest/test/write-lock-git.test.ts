import './_temp-cleanup.js';
import './_sidequest-install-fixture.js';
'use strict';

// SQ-3348. Dispatch and release ran Git under withTicketLock's BEGIN IMMEDIATE, so one slow checkout held the
// board-wide SQLite write lock, and nested ticket file locks were taken inside an open transaction (ABBA).
// Every Git call and every ticket file-lock acquisition below is checked against a second connection's
// BEGIN IMMEDIATE with a zero busy timeout and against every store connection's own isTransaction.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const sqlite = require('node:sqlite');
const { DatabaseSync } = sqlite;
const { creationGeneration } = require('./_creation-generation.js');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-write-lock-git-home-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;

type GitHook = (args: readonly string[]) => void;
const observed = { gitCalls: 0, gitUnderWriteLock: [] as string[], lockFilesUnderTransaction: [] as string[] };
let gitHook: GitHook | null = null;
let storeLoaded = false;
// The store opens its connection through node:sqlite, so wrapping the constructor before the store loads is how the
// test sees that connection's isTransaction. The probes below use the unwrapped constructor.
const storeConnections: InstanceType<typeof DatabaseSync>[] = [];
sqlite.DatabaseSync = class RecordedDatabaseSync extends DatabaseSync {
  constructor(...args: ConstructorParameters<typeof DatabaseSync>) {
    super(...args);
    storeConnections.push(this);
  }
};

function storeTransactionOpen(): boolean {
  return storeConnections.some((connection) => connection.isOpen && connection.isTransaction);
}

function writeLockAvailable(): boolean {
  const probe = new DatabaseSync(path.join(SIDEQUEST_HOME, 'sidequest.db'), { timeout: 0 });
  try {
    probe.exec('BEGIN IMMEDIATE');
    probe.exec('ROLLBACK');
    return true;
  } catch (error: unknown) {
    if (/locked|busy/i.test(String((error as Error).message))) return false;
    throw error;
  } finally {
    probe.close();
  }
}

function observeGit(file: unknown, args: unknown): void {
  if (file !== 'git' || !storeLoaded) return;
  const gitArgs = Array.isArray(args) ? args.map(String) : [];
  observed.gitCalls += 1;
  if (!writeLockAvailable()) observed.gitUnderWriteLock.push(gitArgs.join(' '));
  gitHook?.(gitArgs);
}

const realExecFileSync = childProcess.execFileSync;
const realSpawnSync = childProcess.spawnSync;
childProcess.execFileSync = function observedExecFileSync(this: unknown, file: unknown, args: unknown, ...rest: unknown[]) {
  observeGit(file, args);
  return realExecFileSync.call(this, file, args, ...rest);
};
childProcess.spawnSync = function observedSpawnSync(this: unknown, file: unknown, args: unknown, ...rest: unknown[]) {
  observeGit(file, args);
  return realSpawnSync.call(this, file, args, ...rest);
};
const realOpenSync = fs.openSync;
fs.openSync = function observedOpenSync(this: unknown, file: unknown, flags: unknown, ...rest: unknown[]) {
  if (flags === 'wx' && String(file).endsWith('.lock') && storeTransactionOpen()) {
    observed.lockFilesUnderTransaction.push(path.basename(String(file)));
  }
  return realOpenSync.call(this, file, flags, ...rest);
};

const sidequest = require('../lib/store.js');
storeLoaded = true;
const worktreeLease = require('../lib/kernel/worktree.js');
const worktrees = require('../lib/worktrees.js');
const { createLocks } = require('../lib/store/locks.js');
const database = require('../lib/db.js');

function git(cwd: string, args: string[]): string {
  return realExecFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function initRepo(): string {
  const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-write-lock-git-project-')));
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Sidequest Test']);
  git(repo, ['config', 'user.email', 'sidequest-test@example.invalid']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'write lock fixture\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'base']);
  return repo;
}

const PROJECT = initRepo();
const { slug } = sidequest.ensureProject(PROJECT);
const exploration = sidequest.getCategory('codebase-exploration');
sidequest.setCategory(Object.assign({}, exploration, { route: { model: 'sonnet', effort: 'medium' }, fallback: null }));

function resetObservations(): void {
  observed.gitCalls = 0;
  observed.gitUnderWriteLock = [];
  observed.lockFilesUnderTransaction = [];
}

function assertNoGitOrLockUnderWriteLock(operation: string): void {
  assert.ok(observed.gitCalls > 0, `${operation} ran no Git at all, so it proves nothing`);
  assert.deepEqual(observed.gitUnderWriteLock, [], `${operation} ran Git while holding the SQLite write lock`);
  assert.deepEqual(observed.lockFilesUnderTransaction, [], `${operation} took a ticket file lock inside a transaction`);
}

function completeCheckoutCreation(sessionId: string, worktree: string): void {
  const gitDirectoryValue = git(worktree, ['rev-parse', '--git-dir']);
  const gitDirectory = path.isAbsolute(gitDirectoryValue) ? gitDirectoryValue : path.resolve(worktree, gitDirectoryValue);
  worktreeLease.createCheckoutInstanceMarker(gitDirectory);
  assert.equal(sidequest.completeDispatchWorktreeCreation(slug, sessionId, worktree, creationGeneration(slug, sessionId, worktree)).ok, true);
}

function removeWorktreeBranch(worktree: string, branch: string): void {
  if (fs.existsSync(worktree)) git(PROJECT, ['worktree', 'remove', '--force', worktree]);
  try { git(PROJECT, ['branch', '-D', branch]); } catch (_: unknown) {}
}

type LaunchedCheckout = { ref: string; sessionId: string; worktree: string; branch: string; token: string; executor: string; agentName: string };

function launchIsolatedCheckout(label: string): LaunchedCheckout {
  const sequence = `${label}-${process.pid}-${Date.now()}`;
  const ticket = sidequest.createTicket(slug, { title: `write lock ${sequence}`, category: 'codebase-exploration', description: 'SQ-3348 fixture.', files: ['README.md'] });
  const sessionId = `session-${sequence}`;
  const agentName = `agent-${sequence}`;
  const worktree = path.join(SIDEQUEST_HOME, 'targets', sequence);
  const branch = `branch-${sequence}`;
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  const prepared = sidequest.prepareDispatch(slug, ticket.ref, { sessionId });
  assert.equal(prepared.ok, true, JSON.stringify(prepared).slice(0, 600));
  const executor = prepared.ticket.dispatchExecutor;
  assert.equal(sidequest.recordDispatchLaunch(slug, ticket.ref, { token: prepared.token, executor, sessionId, agentName }).ok, true);
  assert.equal(sidequest.bindDispatchWorktreeCreation(slug, sessionId, worktree).ok, true);
  git(PROJECT, ['worktree', 'add', '-b', branch, worktree, 'HEAD']);
  completeCheckoutCreation(sessionId, worktree);
  return { ref: ticket.ref, sessionId, worktree, branch, token: prepared.token, executor, agentName };
}

function retiredCheckout(label: string): LaunchedCheckout {
  const launched = launchIsolatedCheckout(label);
  assert.equal(sidequest.recordDispatchAgentFailure(slug, launched.ref, {
    token: launched.token, executor: launched.executor, sessionId: launched.sessionId,
    taskName: launched.agentName, error: 'Subagent terminated unexpectedly', source: 'test',
  }).ok, true);
  return launched;
}

test('a re-dispatch reclaims the retired checkout with Git outside the write lock, after its commit', () => {
  const retired = retiredCheckout('reclaim');
  try {
    resetObservations();
    const retry = sidequest.prepareDispatch(slug, retired.ref, { sessionId: `${retired.sessionId}-retry` });
    assert.equal(retry.ok, true);
    assertNoGitOrLockUnderWriteLock('prepareDispatch reclaiming a retired checkout');
    assert.equal(fs.existsSync(retired.worktree), false, 'the retired checkout is removed once the dispatch commits');
    assert.equal(sidequest.getTicket(slug, retired.ref).dispatchNonce, retry.token);
  } finally {
    sidequest.releaseTicket(slug, retired.ref, 'cleanup', { status: 'todo', source: 'test', force: true });
    removeWorktreeBranch(retired.worktree, retired.branch);
  }
});

test('a checkout removal that fails after commit reports the committed dispatch and keeps the checkout', () => {
  const retired = retiredCheckout('cleanup-failure');
  gitHook = (args) => {
    if (args[0] === 'worktree' && args[1] === 'remove') throw new Error('simulated worktree remove failure');
  };
  try {
    const retry = sidequest.prepareDispatch(slug, retired.ref, { sessionId: `${retired.sessionId}-retry` });
    assert.equal(retry.ok, true, 'a cleanup failure must not report the committed dispatch as unwritten');
    assert.ok(retry.warnings.some((warning: string) => /removing the retired checkout failed/.test(warning)), retry.warnings.join('\n'));
    const stored = sidequest.getTicket(slug, retired.ref);
    assert.equal(stored.dispatchNonce, retry.token, 'the new dispatch is committed');
    assert.equal(fs.existsSync(retired.worktree), true, 'the checkout whose removal failed is left in place');
  } finally {
    gitHook = null;
    sidequest.releaseTicket(slug, retired.ref, 'cleanup', { status: 'todo', source: 'test', force: true });
    removeWorktreeBranch(retired.worktree, retired.branch);
  }
});

function branchExists(branch: string): boolean {
  return realSpawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: PROJECT, windowsHide: true }).status === 0;
}

test('a checkout removed before its branch deletion fails is reported as removed with the branch kept', () => {
  const retired = retiredCheckout('branch-failure');
  gitHook = (args) => {
    if (args[0] === 'update-ref' && args[1] === '-d') throw new Error('simulated branch deletion failure');
  };
  try {
    const retry = sidequest.prepareDispatch(slug, retired.ref, { sessionId: `${retired.sessionId}-retry` });
    assert.equal(retry.ok, true);
    const warnings: string[] = retry.warnings || [];
    assert.ok(warnings.some((warning) => /was removed, but deleting its branch .* failed and the branch was kept/.test(warning)), warnings.join('\n'));
    assert.ok(!warnings.some((warning) => /left in place/.test(warning)), 'the removed checkout is not reported as kept');
    assert.equal(fs.existsSync(retired.worktree), false, 'the checkout really was removed');
    assert.equal(branchExists(retired.branch), true, 'the branch whose deletion failed is still there');
  } finally {
    gitHook = null;
    sidequest.releaseTicket(slug, retired.ref, 'cleanup', { status: 'todo', source: 'test', force: true });
    removeWorktreeBranch(retired.worktree, retired.branch);
  }
});

test('a candidate committed between the reclaim decision and the removal keeps the checkout and its branch', () => {
  const retired = retiredCheckout('late-candidate');
  try {
    const decision = worktrees.unclaimedDispatchWorktreeReclaim(PROJECT, sidequest.getTicket(slug, retired.ref).dispatch);
    assert.equal(typeof decision.reclaim, 'function', JSON.stringify(decision));
    commitInCheckout(retired.worktree, 'late-candidate.txt');
    const removal = decision.reclaim();
    assert.equal(removal.reclaimed, false);
    assert.equal(removal.reason, 'candidate_commit');
    assert.equal(fs.existsSync(retired.worktree), true, 'the checkout holding the late candidate stays');
    assert.equal(git(PROJECT, ['rev-parse', `refs/heads/${retired.branch}`]), git(retired.worktree, ['rev-parse', 'HEAD']), 'its branch still retains the candidate');
    assert.equal(fs.existsSync(checkoutHeadLock(retired.worktree)), false, 'a refusal releases the HEAD lock it took');
  } finally {
    sidequest.releaseTicket(slug, retired.ref, 'cleanup', { status: 'todo', source: 'test', force: true });
    removeWorktreeBranch(retired.worktree, retired.branch);
  }
});

function checkoutHeadLock(worktree: string): string {
  return path.resolve(worktree, git(worktree, ['rev-parse', '--git-dir']), 'HEAD.lock');
}

function waitForFile(file: string): void {
  const deadline = Date.now() + 30_000;
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${file}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
}

type PausedCommit = { resume: () => { status: number | null; stderr: string } };

// Pauses a real `git commit` in its commit-msg hook: after it wrote the index and released index.lock, before it
// writes the commit object and moves HEAD. resume() lets it finish and waits for its exit.
function commitPausedAfterIndexWrite(worktree: string): PausedCommit {
  const signals = fs.mkdtempSync(path.join(SIDEQUEST_HOME, 'paused-commit-'));
  const signal = (name: string) => path.join(signals, name).replace(/\\/g, '/');
  const hooks = path.join(signals, 'hooks');
  fs.mkdirSync(hooks);
  fs.writeFileSync(path.join(hooks, 'commit-msg'), `#!/bin/sh\n: > "${signal('paused')}"\nwhile [ ! -f "${signal('resume')}" ]; do sleep 0.05; done\n`, { mode: 0o755 });
  const runner = "const r = require('node:child_process').spawnSync('git', process.argv.slice(1), { encoding: 'utf8' }); require('node:fs').writeFileSync(process.env.SQ_COMMIT_DONE, JSON.stringify({ status: r.status, stderr: r.stderr }));";
  childProcess.spawn(process.execPath, ['-e', runner, '--', '-c',`core.hooksPath=${hooks.replace(/\\/g, '/')}`, '-c', 'user.name=Sidequest Test', '-c', 'user.email=sidequest-test@example.invalid', 'commit', '-m', 'in flight'], {
    cwd: worktree, stdio: 'ignore', windowsHide: true, env: { ...process.env, SQ_COMMIT_DONE: signal('done') },
  });
  waitForFile(signal('paused'));
  return {
    resume() {
      fs.writeFileSync(signal('resume'), '');
      waitForFile(signal('done'));
      return JSON.parse(fs.readFileSync(signal('done'), 'utf8'));
    },
  };
}

// SQ-3472: the bound review's interleaving. The commit wrote its index before the reclaim took its lock and moves
// its ref after the final HEAD and branch reads, just before `git worktree remove` runs.
test('a commit that wrote its index before the reclaim fails at its ref update and the dirty checkout is kept', () => {
  const retired = retiredCheckout('in-flight-commit');
  const base = git(retired.worktree, ['rev-parse', 'HEAD']);
  let paused: PausedCommit | null = null;
  let commit: { status: number | null; stderr: string } | null = null;
  gitHook = (args) => {
    if (args[0] === 'worktree' && args[1] === 'remove' && paused) commit = paused.resume();
  };
  try {
    const decision = worktrees.unclaimedDispatchWorktreeReclaim(PROJECT, sidequest.getTicket(slug, retired.ref).dispatch);
    assert.equal(typeof decision.reclaim, 'function', JSON.stringify(decision));
    fs.writeFileSync(path.join(retired.worktree, 'in-flight.txt'), 'staged before the reclaim\n');
    git(retired.worktree, ['add', 'in-flight.txt']);
    paused = commitPausedAfterIndexWrite(retired.worktree);
    assert.throws(() => decision.reclaim(), 'the non-forced removal refuses the checkout the failed commit left dirty');
    assert.ok(commit, 'the in-flight commit finished between the final reads and the removal');
    assert.notEqual(commit!.status, 0, 'the in-flight commit could not move HEAD while the reclaim held its lock');
    assert.match(commit!.stderr, /HEAD\.lock/);
    assert.equal(fs.existsSync(retired.worktree), true, 'the checkout stays');
    assert.match(git(retired.worktree, ['status', '--porcelain']), /^A {2}in-flight\.txt$/m, 'the staged change is still in the checkout');
    assert.equal(git(retired.worktree, ['rev-parse', 'HEAD']), base);
    assert.equal(git(PROJECT, ['rev-parse', `refs/heads/${retired.branch}`]), base, 'the branch stays where it was');
    assert.equal(fs.existsSync(checkoutHeadLock(retired.worktree)), false, 'the reclaim released its HEAD lock');
  } finally {
    gitHook = null;
    if (paused && !commit) paused.resume();
    sidequest.releaseTicket(slug, retired.ref, 'cleanup', { status: 'todo', source: 'test', force: true });
    removeWorktreeBranch(retired.worktree, retired.branch);
  }
});

// SQ-3463: the commit is attempted after the final HEAD and branch reads and the dependency cleanup, just before
// `git worktree remove` runs.
test('a commit attempted between the final reads and the removal is refused by the held HEAD lock, so nothing is lost', () => {
  const retired = retiredCheckout('late-commit');
  const lateCommits: { status: number | null; stderr: string }[] = [];
  gitHook = (args) => {
    if (args[0] !== 'worktree' || args[1] !== 'remove') return;
    lateCommits.push(realSpawnSync('git', ['-c', 'user.name=Sidequest Test', '-c', 'user.email=sidequest-test@example.invalid', 'commit', '--allow-empty', '-m', 'late'], { cwd: retired.worktree, encoding: 'utf8', windowsHide: true }));
  };
  try {
    const decision = worktrees.unclaimedDispatchWorktreeReclaim(PROJECT, sidequest.getTicket(slug, retired.ref).dispatch);
    assert.equal(typeof decision.reclaim, 'function', JSON.stringify(decision));
    const removal = decision.reclaim();
    assert.equal(lateCommits.length, 1, 'the late commit was attempted just before the removal');
    assert.notEqual(lateCommits[0]!.status, 0, 'the late commit could not land while the reclaim held the HEAD lock');
    assert.match(lateCommits[0]!.stderr, /HEAD\.lock/);
    assert.equal(removal.reclaimed, true, JSON.stringify(removal));
    assert.equal(fs.existsSync(retired.worktree), false);
  } finally {
    gitHook = null;
    sidequest.releaseTicket(slug, retired.ref, 'cleanup', { status: 'todo', source: 'test', force: true });
    removeWorktreeBranch(retired.worktree, retired.branch);
  }
});

test('a reclaim that finds the HEAD lock already held keeps the checkout, the branch and the foreign lock', () => {
  const retired = retiredCheckout('held-head-lock');
  const headLock = checkoutHeadLock(retired.worktree);
  try {
    const decision = worktrees.unclaimedDispatchWorktreeReclaim(PROJECT, sidequest.getTicket(slug, retired.ref).dispatch);
    assert.equal(typeof decision.reclaim, 'function', JSON.stringify(decision));
    fs.writeFileSync(headLock, '');
    const removal = decision.reclaim();
    assert.equal(removal.reclaimed, false);
    assert.equal(removal.reason, 'commit_in_progress');
    assert.match(removal.message, /immutable recovery fact: .*HEAD\.lock exists/);
    assert.equal(fs.existsSync(retired.worktree), true, 'the checkout stays');
    assert.equal(branchExists(retired.branch), true, 'the branch stays');
    assert.equal(fs.existsSync(headLock), true, 'the lock another Git command holds is left alone');
  } finally {
    fs.rmSync(headLock, { force: true });
    sidequest.releaseTicket(slug, retired.ref, 'cleanup', { status: 'todo', source: 'test', force: true });
    removeWorktreeBranch(retired.worktree, retired.branch);
  }
});

test('a branch moved between the reclaim decision and the removal keeps the checkout and the branch', () => {
  const retired = retiredCheckout('late-branch');
  try {
    const decision = worktrees.unclaimedDispatchWorktreeReclaim(PROJECT, sidequest.getTicket(slug, retired.ref).dispatch);
    assert.equal(typeof decision.reclaim, 'function', JSON.stringify(decision));
    git(retired.worktree, ['checkout', '--quiet', '--detach']);
    const late = git(PROJECT, ['commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'late branch commit']);
    git(PROJECT, ['branch', '-f', retired.branch, late]);
    const removal = decision.reclaim();
    assert.equal(removal.reclaimed, false);
    assert.equal(removal.reason, 'live_branch');
    assert.equal(fs.existsSync(retired.worktree), true);
    assert.equal(git(PROJECT, ['rev-parse', `refs/heads/${retired.branch}`]), late, 'the moved branch is not deleted');
  } finally {
    sidequest.releaseTicket(slug, retired.ref, 'cleanup', { status: 'todo', source: 'test', force: true });
    removeWorktreeBranch(retired.worktree, retired.branch);
  }
});

type CrossedReservation = { ref: string; id: string; token: string; executor: string; agentName: string; agentId: string; worktree: string };

function crossedReservation(sessionId: string, label: string): CrossedReservation {
  const ticket = sidequest.createTicket(slug, { title: `crossed ${label}`, category: 'codebase-exploration', description: 'SQ-3449 fixture.', files: ['README.md'] });
  const prepared = sidequest.prepareDispatch(slug, ticket.ref, { sessionId, sharedTree: false });
  const agentName = `crossed-${label}`;
  assert.equal(sidequest.recordDispatchLaunch(slug, ticket.ref, { token: prepared.token, executor: prepared.ticket.dispatchExecutor, sessionId, agentName }).ok, true);
  const agentId = `agent${label}`.replace(/[^a-z0-9]/g, '');
  return { ref: ticket.ref, id: ticket.id, token: prepared.token, executor: prepared.ticket.dispatchExecutor, agentName, agentId, worktree: worktrees.agentWorktreePath(PROJECT, agentId) };
}

function createCheckout(sessionId: string, worktree: string): void {
  assert.equal(sidequest.bindDispatchWorktreeCreation(slug, sessionId, worktree).ok, true);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  git(PROJECT, ['worktree', 'add', '--detach', '--quiet', worktree]);
  completeCheckoutCreation(sessionId, worktree);
}

test('a crossed-creation exchange whose second side turns ineligible writes neither side', () => {
  const sessionId = `crossed-${process.pid}-${Date.now()}`;
  const order = (reservations: CrossedReservation[]) => {
    const boardOrder = sidequest.listTickets(slug).map((ticket: { ref: string }) => ticket.ref);
    return reservations.sort((left, right) => boardOrder.indexOf(left.ref) - boardOrder.indexOf(right.ref));
  };
  const [first, second] = order([crossedReservation(sessionId, 'xa'), crossedReservation(sessionId, 'xb')]) as [CrossedReservation, CrossedReservation];
  createCheckout(sessionId, second.worktree);
  createCheckout(sessionId, first.worktree);
  assert.equal(sidequest.getTicket(slug, first.ref).dispatch.worktree, worktreeLease.canonicalPath(second.worktree), 'the fixture reproduces the crossing');
  // The side written first is the lower id, so it reports and the other side is the holder that turns ineligible.
  const [target, holder] = [first, second].sort((left, right) => left.id.localeCompare(right.id)) as [CrossedReservation, CrossedReservation];
  const targetBefore = sidequest.getTicket(slug, target.ref).dispatch;
  gitHook = (args) => {
    if (!args.includes('HEAD^{commit}')) return;
    gitHook = null;
    const writer = new DatabaseSync(path.join(SIDEQUEST_HOME, 'sidequest.db'), { timeout: 2000 });
    try {
      writer.prepare("UPDATE tickets SET data = json_set(data, '$.dispatch.agentId', 'late-bound-agent') WHERE project = ? AND id = ?").run(slug, holder.id);
    } finally {
      writer.close();
    }
  };
  try {
    sidequest.bindDispatchAgent(sessionId, target.executor, target.agentId, target.agentName, target.worktree);
    const targetAfter = sidequest.getTicket(slug, target.ref).dispatch;
    assert.equal(targetAfter.worktreeBindingExchange, targetBefore.worktreeBindingExchange, 'the reporting side was not exchanged alone');
    assert.equal(targetAfter.worktree, targetBefore.worktree, 'the reporting side still records the checkout it held');
    assert.equal(sidequest.getTicket(slug, holder.ref).dispatch.agentId, 'late-bound-agent');
  } finally {
    gitHook = null;
    for (const reservation of [first, second]) {
      sidequest.releaseTicket(slug, reservation.ref, 'cleanup', { status: 'todo', source: 'test', force: true });
      if (fs.existsSync(reservation.worktree)) git(PROJECT, ['worktree', 'remove', '--force', reservation.worktree]);
    }
  }
});

test('a composition adopted while dispatch waits for its locks is re-admitted under the new lock set', () => {
  const { createCompositionAdmissions } = require('../lib/store/composition-admission.js');
  const root: Record<string, unknown> = { id: 'root-id', ref: 'SQ-1', status: 'todo' };
  const source = { id: 'source-id', ref: 'SQ-2', status: 'done' };
  const byRef = (ref: string) => [root, source].find((ticket) => ticket.ref === ref || ticket.id === ref);
  const locked: string[][] = [];
  const admissions = createCompositionAdmissions({
    getTicket: (_slug: string, ref: string) => byRef(ref),
    listTickets: () => [root, source],
    submissionReviewRelation: () => null,
    readMeta: () => ({ path: PROJECT }),
    withTicketFileLocks: (keys: readonly { id: string }[], callback: () => unknown) => {
      locked.push(keys.map((key) => key.id));
      root.compositionAdmission = { sources: [{ ref: 'SQ-2' }] };
      return callback();
    },
    withTicketLocks: () => assert.fail('dispatch preparation must not open a write transaction'),
    putTicket: () => assert.fail('dispatch preparation must not write'),
    createComment: () => assert.fail('dispatch preparation must not comment'),
    invalidateStoreCaches: () => {},
    dispatchTokenDigest: (nonce: string) => nonce,
  });
  assert.throws(() => admissions.withCompositionDispatchPreparation(slug, 'SQ-1', (_lockedIds: readonly string[], assertAdmissionHolds: () => void) => {
    assertAdmissionHolds();
    assert.fail('an admission adopted during the lock wait must not be consumed under the root lock alone');
  }), /admission_changed/);
  assert.deepEqual(locked, [['root-id']], 'the dispatch waited on the root lock only, so it holds no source lock');
});

test('a ticket written while dispatch reads its checkouts refuses without writing or reclaiming', () => {
  const retired = retiredCheckout('race');
  const before = sidequest.getTicket(slug, retired.ref);
  let raced = false;
  gitHook = (args) => {
    if (raced || args[0] !== 'status') return;
    raced = true;
    const writer = new DatabaseSync(path.join(SIDEQUEST_HOME, 'sidequest.db'), { timeout: 2000 });
    try {
      writer.prepare("UPDATE tickets SET data = json_set(data, '$.raceMarker', 1) WHERE project = ? AND id = ?").run(slug, before.id);
    } finally {
      writer.close();
    }
  };
  try {
    assert.throws(() => sidequest.prepareDispatch(slug, retired.ref, { sessionId: `${retired.sessionId}-retry` }),
      /changed while this dispatch was reading its checkouts, so nothing was written/);
    const after = sidequest.getTicket(slug, retired.ref);
    assert.equal(after.raceMarker, 1);
    assert.equal(after.dispatchNonce, before.dispatchNonce, 'the stale preparation minted nothing');
    assert.deepEqual(after.dispatch, before.dispatch);
    assert.equal(fs.existsSync(retired.worktree), true, 'no checkout is removed for an uncommitted preparation');
  } finally {
    gitHook = null;
    sidequest.releaseTicket(slug, retired.ref, 'cleanup', { status: 'todo', source: 'test', force: true });
    removeWorktreeBranch(retired.worktree, retired.branch);
  }
});

test('releasing an isolated claim observes its checkout before the write transaction', () => {
  const launched = launchIsolatedCheckout('release');
  const owner = `owner-${launched.sessionId}`;
  try {
    assert.equal(sidequest.bindDispatchAgent(launched.sessionId, launched.executor, launched.agentName, launched.agentName, launched.worktree).ok, true);
    assert.equal(sidequest.claimTicket(slug, launched.ref, owner, { token: launched.token, executor: launched.executor, sessionId: launched.sessionId, requireBoundAgent: true }).ok, true);
    resetObservations();
    const released = sidequest.releaseTicket(slug, launched.ref, owner, { status: 'todo', source: 'test', releaseKind: 'handback', releaseReason: 'SQ-3348 fixture' });
    assert.equal(released.ok, true, released.message);
    assertNoGitOrLockUnderWriteLock('releaseTicket of an isolated claim');
    assert.equal(sidequest.getTicket(slug, launched.ref).dispatch.terminalWorktreeRevision, git(launched.worktree, ['rev-parse', 'HEAD']));
  } finally {
    sidequest.releaseTicket(slug, launched.ref, 'cleanup', { status: 'todo', source: 'test', force: true });
    removeWorktreeBranch(launched.worktree, launched.branch);
  }
});

test('a session-bearing release takes the workers lock outside its write transaction', () => {
  const launched = launchIsolatedCheckout('release-session');
  const owner = `owner-${launched.sessionId}`;
  try {
    assert.equal(sidequest.bindDispatchAgent(launched.sessionId, launched.executor, launched.agentName, launched.agentName, launched.worktree).ok, true);
    assert.equal(sidequest.claimTicket(slug, launched.ref, owner, { token: launched.token, executor: launched.executor, sessionId: launched.sessionId, requireBoundAgent: true }).ok, true);
    const lockOpens: string[] = [];
    const recordLockOpen = fs.openSync;
    fs.openSync = function recordedOpenSync(this: unknown, file: unknown, flags: unknown, ...rest: unknown[]) {
      if (flags === 'wx' && String(file).endsWith('.lock')) lockOpens.push(path.basename(String(file)));
      return recordLockOpen.call(this, file, flags, ...rest);
    };
    resetObservations();
    try {
      const released = sidequest.releaseTicket(slug, launched.ref, owner, { status: 'todo', source: 'test', sessionId: launched.sessionId, releaseKind: 'handback', releaseReason: 'SQ-3449 fixture' });
      assert.equal(released.ok, true, released.message);
    } finally {
      fs.openSync = recordLockOpen;
    }
    assert.ok(lockOpens.some((name) => /workers/.test(name)), `the release drops its registry entry under the workers lock: ${lockOpens.join(', ')}`);
    assertNoGitOrLockUnderWriteLock('releaseTicket with a session id');
  } finally {
    sidequest.releaseTicket(slug, launched.ref, 'cleanup', { status: 'todo', source: 'test', force: true });
    removeWorktreeBranch(launched.worktree, launched.branch);
  }
});

test('a ticket written while release reads its checkout refuses without writing', () => {
  const launched = launchIsolatedCheckout('release-race');
  const owner = `owner-${launched.sessionId}`;
  try {
    assert.equal(sidequest.bindDispatchAgent(launched.sessionId, launched.executor, launched.agentName, launched.agentName, launched.worktree).ok, true);
    assert.equal(sidequest.claimTicket(slug, launched.ref, owner, { token: launched.token, executor: launched.executor, sessionId: launched.sessionId, requireBoundAgent: true }).ok, true);
    const id = sidequest.getTicket(slug, launched.ref).id;
    gitHook = () => {
      gitHook = null;
      const writer = new DatabaseSync(path.join(SIDEQUEST_HOME, 'sidequest.db'), { timeout: 2000 });
      try {
        writer.prepare("UPDATE tickets SET data = json_set(data, '$.raceMarker', 1) WHERE project = ? AND id = ?").run(slug, id);
      } finally {
        writer.close();
      }
    };
    const released = sidequest.releaseTicket(slug, launched.ref, owner, { status: 'todo', source: 'test', releaseKind: 'handback', releaseReason: 'SQ-3348 fixture' });
    assert.equal(released.ok, false);
    assert.equal(released.reason, 'ticket_changed');
    assert.equal(sidequest.getTicket(slug, launched.ref).claim.by, owner, 'the claim is untouched');
  } finally {
    gitHook = null;
    sidequest.releaseTicket(slug, launched.ref, 'cleanup', { status: 'todo', source: 'test', force: true });
    removeWorktreeBranch(launched.worktree, launched.branch);
  }
});

test('a sweep releasing a dead shared-tree claim inspects the checkout outside the write transaction', () => {
  const ticket = sidequest.createTicket(slug, { title: `shared sweep ${process.pid}-${Date.now()}`, category: 'codebase-exploration', description: 'SQ-3348 fixture.', files: ['README.md'] });
  const owner = 'shared-tree-sweep-owner';
  const prepared = sidequest.prepareDispatch(slug, ticket.ref, { sharedTree: true });
  assert.equal(prepared.ok, true, JSON.stringify(prepared).slice(0, 600));
  assert.equal(prepared.ticket.dispatch.sharedTree, true);
  assert.equal(sidequest.claimTicket(slug, ticket.ref, owner, { token: prepared.token, executor: prepared.ticket.dispatchExecutor, source: 'test' }).ok, true);
  const backdater = new DatabaseSync(path.join(SIDEQUEST_HOME, 'sidequest.db'), { timeout: 2000 });
  try {
    backdater.prepare("UPDATE tickets SET data = json_set(data, '$.claim.at', '2000-01-01T00:00:00.000Z') WHERE project = ? AND id = ?").run(slug, ticket.id);
  } finally {
    backdater.close();
  }
  try {
    resetObservations();
    const swept = sidequest.sweepStaleClaims({ project: slug, source: 'test' });
    assert.ok(swept.released.some((entry: { ref: string }) => entry.ref === ticket.ref), JSON.stringify(swept));
    assertNoGitOrLockUnderWriteLock('sweepStaleClaims releasing a shared-tree claim');
    assert.equal(sidequest.getTicket(slug, ticket.ref).claim, null);
  } finally {
    sidequest.releaseTicket(slug, ticket.ref, 'cleanup', { status: 'todo', source: 'test', force: true });
  }
});

function claimedSharedTreeTicket(title: string, owner: string): { ref: string; id: string } {
  const ticket = sidequest.createTicket(slug, { title: `${title} ${process.pid}-${Date.now()}`, category: 'codebase-exploration', description: 'SQ-3449 fixture.', files: ['README.md'] });
  const prepared = sidequest.prepareDispatch(slug, ticket.ref, { sharedTree: true });
  assert.equal(sidequest.claimTicket(slug, ticket.ref, owner, { token: prepared.token, executor: prepared.ticket.dispatchExecutor, source: 'test' }).ok, true);
  return ticket;
}

test('a sweep release re-checked under the lock leaves a live claim alone', () => {
  const owner = 'live-sweep-owner';
  const ticket = claimedSharedTreeTicket('live sweep', owner);
  try {
    const refused = sidequest.releaseTicket(slug, ticket.ref, owner, { status: 'todo', source: 'test', requireReleaseVerdict: true });
    assert.equal(refused.reason, 'claim_live');
    assert.match(refused.message, /still live-claimed by "live-sweep-owner"/);
    assert.equal(sidequest.getTicket(slug, ticket.ref).claim.by, owner);
  } finally {
    sidequest.releaseTicket(slug, ticket.ref, 'cleanup', { status: 'todo', source: 'test', force: true });
  }
});

test('a claimed dispatch that lost its claim refuses a foreign release without recovery evidence guidance', () => {
  const ticket = claimedSharedTreeTicket('claim lost', 'claim-lost-owner');
  const editor = new DatabaseSync(path.join(SIDEQUEST_HOME, 'sidequest.db'), { timeout: 2000 });
  try {
    editor.prepare("UPDATE tickets SET data = json_set(data, '$.claim', json('null')) WHERE project = ? AND id = ?").run(slug, ticket.id);
  } finally {
    editor.close();
  }
  try {
    const refused = sidequest.releaseTicket(slug, ticket.ref, 'foreign-executor', { status: 'todo', source: 'test' });
    assert.equal(refused.reason, 'unclaimed_active_dispatch');
    assert.match(refused.message, /has an active claimed dispatch but no claim owned by foreign-executor\. Do not release another runtime's attempt\./);
  } finally {
    sidequest.releaseTicket(slug, ticket.ref, 'cleanup', { status: 'todo', source: 'test', force: true });
  }
});

test('composition dispatch preparation hands control to the caller before it observes the admission', () => {
  const { createCompositionAdmissions } = require('../lib/store/composition-admission.js');
  const events: string[] = [];
  const root = { id: 'root-id', ref: 'SQ-1', status: 'todo', compositionAdmission: { sources: [], consumedBy: { attempt: 1 } } };
  const admissions = createCompositionAdmissions({
    getTicket: () => root,
    listTickets: () => [root],
    submissionReviewRelation: () => null,
    readMeta: () => ({ path: PROJECT }),
    withTicketFileLocks: (keys: readonly { id: string }[], callback: () => unknown) => {
      events.push(`file locks ${keys.map((key) => key.id).join(',')}`);
      return callback();
    },
    withTicketLocks: () => assert.fail('dispatch preparation must not open a write transaction'),
    putTicket: () => assert.fail('dispatch preparation must not write'),
    createComment: () => assert.fail('dispatch preparation must not comment'),
    invalidateStoreCaches: () => {},
    dispatchTokenDigest: (nonce: string) => nonce,
  });
  assert.throws(() => admissions.withCompositionDispatchPreparation(slug, root.ref, (lockedIds: readonly string[], assertAdmissionHolds: () => void) => {
    events.push(`generation snapshot ${lockedIds.join(',')}`);
    assertAdmissionHolds();
    events.push('prepared');
  }), /admission_consumed/);
  assert.deepEqual(events, ['file locks root-id', 'generation snapshot root-id'],
    'the generation snapshot must come before the admission observation, which refuses here');
});

test('multi-ticket locks take every file lock in path order before the one transaction', () => {
  const ticketsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-write-lock-order-'));
  const events: string[] = [];
  let inTransaction = false;
  const recordingFs = Object.assign({}, fs, {
    openSync: (file: string, flags: string) => {
      events.push(`${inTransaction ? 'transaction' : 'outside'}:${path.basename(file)}`);
      return realOpenSync(file, flags);
    },
  });
  const locks = createLocks({
    fs: recordingFs,
    path,
    ticketsDir: () => ticketsDirectory,
    transaction: (fn: () => unknown) => {
      inTransaction = true;
      try { return database.guardedWrite(fn); } finally { inTransaction = false; }
    },
    refuseUnderGuardedWrite: database.refuseUnderGuardedWrite,
  });
  const result = locks.withTicketLocks([{ slug: 's', id: 'beta' }, { slug: 's', id: 'alpha' }, { slug: 's', id: 'beta' }], () => {
    assert.equal(inTransaction, true);
    return 'written';
  });
  assert.equal(result, 'written');
  assert.deepEqual(events, ['outside:.alpha.lock', 'outside:.beta.lock']);
  assert.throws(() => locks.withTicketLocks([{ slug: 's', id: 'outer' }], () => locks.withTicketFileLocks([{ slug: 's', id: 'nested' }], () => 'nested')),
    (error: Error) => error.name === 'WriteLockHeldError' && /waiting on lock file \.nested\.lock/.test(error.message));
  assert.throws(() => locks.withTicketLocks([{ slug: 's', id: 'outer' }], () => locks.acquireLock(path.join(ticketsDirectory, '.workers.lock'))),
    (error: Error) => error.name === 'WriteLockHeldError' && /waiting on lock file \.workers\.lock/.test(error.message),
    'a non-ticket lock file reached inside the write is refused too');
  assert.deepEqual(fs.readdirSync(ticketsDirectory), [], 'every file lock is released');
});

function guardFixtureDatabase() {
  return database.openDb(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-write-lock-guard-')));
}

test('a Git call inside a guarded write transaction is refused before Git starts', () => {
  const handle = guardFixtureDatabase();
  try {
    resetObservations();
    assert.throws(() => database.txn(handle, () => database.guardedWrite(() => childProcess.execFileSync('git', ['--version'], { encoding: 'utf8' }))),
      (error: Error & { code?: string }) => error.name === 'WriteLockHeldError' && error.code === 'write_lock_held' && /starting git/.test(error.message));
    assert.equal(observed.gitCalls, 0, 'the refusal comes before the child process starts');
    assert.equal(handle.isTransaction, false, 'the refused write rolled back');
  } finally {
    handle.close();
  }
});

test('the same Git call before BEGIN runs', () => {
  const handle = guardFixtureDatabase();
  try {
    const version = childProcess.execFileSync('git', ['--version'], { encoding: 'utf8' });
    assert.match(version, /^git version /);
    assert.equal(database.txn(handle, () => database.guardedWrite(() => 'written')), 'written');
  } finally {
    handle.close();
  }
});

test('SIDEQUEST_GUARD_ALL_WRITES guards every write except the paths still listed as spawning', () => {
  const previous = process.env.SIDEQUEST_GUARD_ALL_WRITES;
  try {
    process.env.SIDEQUEST_GUARD_ALL_WRITES = '1';
    assert.equal(database.guardsEveryWrite(), true);
    assert.equal(database.stillSpawnsInsideItsWrite('withCompositionLocks', () => database.guardsEveryWrite()), false);
    assert.equal(database.guardsEveryWrite(), true, 'the exemption ends with the listed write');
    delete process.env.SIDEQUEST_GUARD_ALL_WRITES;
    assert.equal(database.guardsEveryWrite(), false, 'production keeps the per-write guard until the list is empty');
  } finally {
    if (previous === undefined) delete process.env.SIDEQUEST_GUARD_ALL_WRITES;
    else process.env.SIDEQUEST_GUARD_ALL_WRITES = previous;
  }
});

test('a direct claim reads HEAD and registers its session outside the write lock', () => {
  const ticket = sidequest.createTicket(slug, { title: `direct claim ${process.pid}-${Date.now()}`, description: 'SQ-3499 fixture.' });
  resetObservations();
  const claimed = sidequest.claimTicket(slug, ticket.ref, 'direct-owner', { direct: true, sessionId: `sq-3499-${process.pid}`, source: 'test' });
  assert.equal(claimed.ok, true, JSON.stringify(claimed).slice(0, 600));
  assert.equal(claimed.ticket.lifecycleAttempt.baseline.revision.value, git(PROJECT, ['rev-parse', 'HEAD']));
  assert.ok(observed.gitCalls > 0, 'the claim did read HEAD');
  assert.deepEqual(observed.gitUnderWriteLock, []);
  assert.deepEqual(observed.lockFilesUnderTransaction, []);
  assert.ok(sidequest.sessionClaims(`sq-3499-${process.pid}`).some((claim: { ticketId: string }) => claim.ticketId === ticket.id), 'the session registry still records the claim');
});

test('an oracle release is checked before the write: ask, kind, status and a pending verdict', () => {
  const ticket = sidequest.createTicket(slug, { title: `oracle checks ${process.pid}-${Date.now()}`, category: 'codebase-exploration', description: 'SQ-3348 fixture.', files: ['README.md'] });
  const prepared = sidequest.prepareDispatch(slug, ticket.ref, { sharedTree: true });
  assert.equal(prepared.ok, true, JSON.stringify(prepared).slice(0, 600));
  assert.equal(sidequest.claimTicket(slug, ticket.ref, 'oracle-owner', { token: prepared.token, executor: prepared.ticket.dispatchExecutor, source: 'test' }).ok, true);
  const release = (opts: Record<string, string>) => () => sidequest.releaseTicket(slug, ticket.ref, 'oracle-owner', { source: 'test', ...opts });
  assert.throws(release({ releaseKind: 'oracle', status: 'awaiting-oracle' }), /oracle release requires a non-empty oracle ask/);
  assert.throws(release({ releaseKind: 'handback', oracle: 'Which store?' }), /oracle ask requires release kind oracle/);
  assert.throws(release({ releaseKind: 'oracle', oracle: 'Which store?', status: 'todo' }), /oracle release must set the ticket to awaiting-oracle/);
  const asked = release({ releaseKind: 'oracle', oracle: 'Which store?' })();
  assert.equal(asked.ok, true, asked.message);
  assert.equal(sidequest.getTicket(slug, ticket.ref).status, 'awaiting-oracle');
  assert.throws(release({ releaseKind: 'oracle', oracle: 'And again?' }), /ticket already awaits an oracle verdict/);
});

function commitInCheckout(worktree: string, file: string): void {
  fs.writeFileSync(path.join(worktree, file), `${file}\n`);
  git(worktree, ['add', '.']);
  git(worktree, ['-c', 'user.name=Sidequest Test', '-c', 'user.email=sidequest-test@example.invalid', 'commit', '-m', file]);
}

test('a retired checkout holding a commit past its dispatch base is kept as a candidate, never reclaimed', () => {
  const retired = retiredCheckout('candidate');
  try {
    commitInCheckout(retired.worktree, 'candidate.txt');
    const decision = worktrees.reclaimUnclaimedDispatchWorktree(PROJECT, sidequest.getTicket(slug, retired.ref).dispatch);
    assert.equal(decision.reason, 'candidate_commit');
    assert.match(decision.message, /descends from dispatch base/);
    assert.equal(fs.existsSync(retired.worktree), true);
  } finally {
    sidequest.releaseTicket(slug, retired.ref, 'cleanup', { status: 'todo', source: 'test', force: true });
    removeWorktreeBranch(retired.worktree, retired.branch);
  }
});

test('a retired checkout whose head shares no history with its dispatch base is kept as divergent', () => {
  const retired = retiredCheckout('divergent');
  try {
    git(retired.worktree, ['checkout', '--orphan', `orphan-${retired.branch}`]);
    commitInCheckout(retired.worktree, 'divergent.txt');
    const decision = worktrees.reclaimUnclaimedDispatchWorktree(PROJECT, sidequest.getTicket(slug, retired.ref).dispatch);
    assert.equal(decision.reason, 'divergent_candidate');
    assert.match(decision.message, /diverge/);
    assert.equal(fs.existsSync(retired.worktree), true);
  } finally {
    sidequest.releaseTicket(slug, retired.ref, 'cleanup', { status: 'todo', source: 'test', force: true });
    removeWorktreeBranch(retired.worktree, retired.branch);
    try { git(PROJECT, ['branch', '-D', `orphan-${retired.branch}`]); } catch (_: unknown) {}
  }
});
