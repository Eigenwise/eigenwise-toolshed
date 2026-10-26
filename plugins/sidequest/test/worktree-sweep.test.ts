import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withWorktreeSweepLock, worktreeRemovalFailureNotice } from '../src/hooks/shared/worktree-sweep.js';
import { deferralNotice } from '../src/hooks/shared/sweep-handoff.js';
const { worktreeSweepEntryLine, worktreeSweepProgressLine, worktreeSweepReasonSummary } = require('../src/bin/sidequest-cmd-collaboration.ts');

const removalFailure = { path: 'C:\\worktrees\\agent-locked', message: 'Invalid argument' };

test('worktree removal failure reports Windows processes still using the directory', () => {
  const notice = worktreeRemovalFailureNotice(removalFailure, {
    platform: 'win32',
    existsSync: () => true,
    listProcesses: () => [{
      pid: 4201,
      imageName: 'python.exe',
      startTime: '20260813120000.000000+000',
      cpuSeconds: 846,
      command: 'C:/worktrees/agent-locked/.venv/Scripts/python.exe worker.py',
    }],
  });

  assert.match(notice, /could not remove C:\\worktrees\\agent-locked: Invalid argument/);
  assert.match(notice, /pid 4201 \(python\.exe, started 20260813120000\.000000\+000, CPU 846s\)/);
  assert.match(notice, /End those PIDs and re-run the sweep/);
});

test('successful worktree removal does not query Windows processes', () => {
  let queried = false;
  const notice = worktreeRemovalFailureNotice({ path: null, message: 'unused' }, {
    platform: 'win32',
    existsSync: () => true,
    listProcesses: () => {
      queried = true;
      return [];
    },
  });

  assert.equal(notice, 'could not remove a git entry: unused');
  assert.equal(queried, false);
});

test('non-Windows worktree removal failure keeps the existing notice', () => {
  let queried = false;
  const notice = worktreeRemovalFailureNotice(removalFailure, {
    platform: 'linux',
    existsSync: () => true,
    listProcesses: () => {
      queried = true;
      return [];
    },
  });

  assert.equal(notice, 'could not remove C:\\worktrees\\agent-locked: Invalid argument');
  assert.equal(queried, false);
});


test('worktree sweep rows print known facts without placeholder values', () => {
  const row = worktreeSweepEntryLine({
    action: 'keep',
    path: 'C:\\worktrees\\agent-legacy-dirty',
    ticket: null,
    reason: 'legacy_unreclaimed',
    clean: false,
    ahead: 2,
    patchEquivalent: false,
    ageMs: 4 * 60 * 60 * 1000,
  });

  assert.match(row, /legacy_unreclaimed; dirty; ahead 2; patch-equivalent false; age 240m/);
  assert.doesNotMatch(row, /\?/);
});


// A bare `dependency_link_untrusted` named no link and no target, so 29 retained trees read as one
// unexplained refusal and nobody could tell which link to release (SQ-21).
test('a sweep row prints the dependency link refusal detail after its reason code', () => {
  const row = worktreeSweepEntryLine({
    action: 'keep',
    path: 'C:\\worktrees\\agent-linked',
    ticket: 'SQ-21',
    reason: 'dependency_link_untrusted',
    detail: 'node_modules/shared escapes worktree -> C:\\store\\shared',
    clean: true,
    ahead: 0,
    patchEquivalent: false,
    ageMs: 60 * 60 * 1000,
  });

  assert.equal(row, '  KEEP C:\\worktrees\\agent-linked SQ-21 [dependency_link_untrusted: node_modules/shared escapes worktree -> C:\\store\\shared; clean; ahead 0; patch-equivalent false; age 60m]');
});

test('deferred SessionStart sweep reports active classification and the finishing command', () => {
  const notice = deferralNotice('C:/repo', {
    phase: 'classifying',
    candidates: 8,
    observed: 3,
    current: 'C:/worktrees/agent-slow',
    reason: 'legacy_unreclaimed',
    planned: 4,
    removed: 2,
    keptByReason: { legacy_unreclaimed: 1, active_ticket: 3 },
  });

  assert.match(notice, /Classifying 3\/8: C:\/worktrees\/agent-slow \(legacy_unreclaimed\)/);
  assert.match(notice, /Reached planned 4, removed 2, skipped 4 \(legacy_unreclaimed 1, active_ticket 3\)/);
  assert.match(notice, /worktrees sweep --yes --project/);
});

test('manual worktree sweep progress names the classification candidate and reason', () => {
  const line = worktreeSweepProgressLine({
    phase: 'classifying',
    candidates: 8,
    observed: 3,
    current: 'C:/worktrees/agent-slow',
    reason: 'legacy_unreclaimed',
    planned: 0,
    removed: 0,
    keptByReason: {},
  });

  assert.equal(line, 'worktrees sweep: classifying 3/8: C:/worktrees/agent-slow (legacy_unreclaimed); planned 0, removed 0');
});

// GH-439: a 150-tree `worktrees sweep --yes` scrolled every row past and ended on the last failure,
// so the run closes with one count per reason, most frequent first.
test('a manual sweep ends with its count per classification reason', () => {
  const line = worktreeSweepReasonSummary([
    { reason: 'ticket_closed_settled' },
    { reason: 'status_unknown' },
    { reason: 'ticket_closed_settled' },
    { reason: 'active_ticket' },
  ]);

  assert.equal(line, '  by reason: ticket_closed_settled 2, active_ticket 1, status_unknown 1');
  assert.equal(worktreeSweepReasonSummary([]), '  by reason: no candidates');
});

// A SessionEnd sweep and the next SessionStart sweep run back to back on /clear; the lock keeps
// them from quarantining the same trees twice (SQ-51).
async function sweepUnderLockFile(lockContents: string | null): Promise<{ result: string[]; ran: boolean; lockAfter: string | null }> {
  const previousHome = process.env.SIDEQUEST_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-sweep-lock-'));
  const lockFile = path.join(home, 'worktree-sweep.lock');
  process.env.SIDEQUEST_HOME = home;
  try {
    if (lockContents !== null) fs.writeFileSync(lockFile, lockContents);
    let ran = false;
    const result = await withWorktreeSweepLock(async () => {
      ran = true;
      return ['swept'];
    });
    return { result, ran, lockAfter: fs.existsSync(lockFile) ? fs.readFileSync(lockFile, 'utf8') : null };
  } finally {
    process.env.SIDEQUEST_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('a sweep lock held by a live process skips the sweep and leaves the lock alone', async () => {
  const held = await sweepUnderLockFile(String(process.pid));

  assert.equal(held.ran, false);
  assert.deepEqual(held.result, []);
  assert.equal(held.lockAfter, String(process.pid));
});

test('a sweep lock left by a dead process is cleared and the sweep runs', async () => {
  const stale = await sweepUnderLockFile('99999999');

  assert.equal(stale.ran, true);
  assert.deepEqual(stale.result, ['swept']);
  assert.equal(stale.lockAfter, null);
});

test('a sweep lock with unreadable contents is cleared and the sweep runs', async () => {
  const garbage = await sweepUnderLockFile('not a pid');

  assert.equal(garbage.ran, true);
  assert.deepEqual(garbage.result, ['swept']);
  assert.equal(garbage.lockAfter, null);
});

const { execFileSync } = require('node:child_process');
const worktrees = require('../src/lib/worktrees.ts');

function sweepFixtureGit(repository: string, argumentsList: string[]): string {
  return execFileSync('git', argumentsList, { cwd: repository, encoding: 'utf8', windowsHide: true }).trim();
}

function sizeSweepFixture(home: string) {
  // realpath: the Windows CI runner's TEMP is an 8.3 short name and the sweep reports long-form paths.
  const repository = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-sizes-repository-')));
  sweepFixtureGit(repository, ['init', '-b', 'main']);
  sweepFixtureGit(repository, ['config', 'user.name', 'Sidequest Test']);
  sweepFixtureGit(repository, ['config', 'user.email', 'test@example.invalid']);
  fs.writeFileSync(path.join(repository, 'README'), 'fixture');
  sweepFixtureGit(repository, ['add', '.']);
  sweepFixtureGit(repository, ['commit', '-m', 'base']);
  const group = worktrees.worktreeRoot(repository);
  const tree = path.join(group, 'agent-done').replaceAll(path.sep, '/');
  sweepFixtureGit(repository, ['worktree', 'add', '-b', 'worktree-agent-done', tree]);
  const gitDirectory = sweepFixtureGit(tree, ['rev-parse', '--absolute-git-dir']);
  const checkoutInstance = require('../src/lib/kernel/worktree.ts').createCheckoutInstanceMarker(gitDirectory);
  const revision = sweepFixtureGit(tree, ['rev-parse', 'HEAD']);
  const terminalAt = new Date().toISOString();
  const terminal = { terminalAt, terminalSource: 'test-store-transition', outcome: 'done' };
  const ticket = { ref: 'SQ-SIZES', status: 'done', claimLive: false, dispatch: {
    agentId: 'done', sharedTree: false, worktree: tree, baseCommit: revision,
    worktreeBindingSource: 'worktree-create', worktreeCreationCompletedAt: terminalAt,
    worktreeGitDirectory: gitDirectory, worktreeCommonGitDirectory: path.join(repository, '.git'),
    worktreeCheckoutInstance: checkoutInstance, worktreeObservedRevision: revision,
    ownedDependencyLinks: [], ...terminal, attempts: [terminal],
  } };
  const sibling = path.join(home, 'worktrees', 'sibling-board', 'agent-large');
  fs.mkdirSync(sibling, { recursive: true });
  fs.writeFileSync(path.join(sibling, 'large-cache'), Buffer.alloc(1024 * 1024));
  return { repository, tree, group, ticket, sibling };
}

for (const includeStoreUsage of [false, true]) {
  test('sweep sizes=' + includeStoreUsage + ' never walks sibling boards and reports named done trees', async () => {
    const previousHome = process.env.SIDEQUEST_HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-sweep-sizes-'));
    process.env.SIDEQUEST_HOME = home;
    const fixture = sizeSweepFixture(home);
    const promises = require('node:fs/promises');
    const originalRead = promises.readdir;
    const reads: string[] = [];
    const events: string[] = [];
    promises.readdir = async (directory: string, ...argumentsList: unknown[]) => {
      reads.push(String(directory));
      if (String(directory) === fixture.sibling) throw new Error('sibling board must never be walked');
      if (String(directory) === fixture.group) events.push('group-read:' + fs.existsSync(fixture.tree));
      return originalRead(directory, ...argumentsList);
    };
    try {
      const result = await worktrees.sweep(fixture.repository, [fixture.ticket], {
        execute: true, minAgeMs: 0, integrationTarget: { upstream: 'main', branch: 'main' }, includeStoreUsage,
        onProgress: (progress: { reason: string | null }) => events.push('progress:' + progress.reason),
      });
      assert.equal(events[0], 'progress:recovery_retention', 'progress precedes recovery and candidate discovery');
      assert.equal(reads.includes(fixture.sibling), false, 'a large sibling board is never walked');
      assert.deepEqual(result.removed.map(worktrees.canonicalPath), [worktrees.canonicalPath(fixture.tree)], 'the done-ticket candidate is removed');
      assert.equal(result.entries[0].reason, 'ticket_closed_settled');
      assert.equal(worktrees.canonicalPath(result.storage.worktrees.path), worktrees.canonicalPath(fixture.group));
      assert.equal(result.storage.worktrees.bytes, includeStoreUsage ? 0 : null);
      assert.equal(events.includes('progress:measuring_sizes'), includeStoreUsage);
      assert.equal(events.slice(includeStoreUsage ? events.indexOf('progress:measuring_sizes') + 1 : events.length).includes('group-read:true'), false, 'size measurement runs after candidate removal');
      const reportPath = require('../src/lib/sweep-state-path.ts').reportFile(fixture.repository).replace(/\.json$/, '.candidates.json');
      const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      assert.deepEqual(report.planned, [fixture.tree]);
      assert.deepEqual(report.removed, [fixture.tree]);
      assert.deepEqual(report.skipped, []);
      assert.equal(report.entries[0].ticket, 'SQ-SIZES');
    } finally {
      promises.readdir = originalRead;
      process.env.SIDEQUEST_HOME = previousHome;
      fs.rmSync(fixture.repository, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}

test('the shipped sweep CLI measures sizes only when --sizes is explicit', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-sweep-cli-sizes-'));
  const previousHome = process.env.SIDEQUEST_HOME;
  process.env.SIDEQUEST_HOME = home;
  const fixture = sizeSweepFixture(home);
  try {
    const command = [path.resolve(__dirname, '../bin/sidequest.js'), 'worktrees', 'sweep', '--dry-run', '--json', '--project', fixture.repository];
    const options = { encoding: 'utf8', windowsHide: true, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] };
    const defaultResult = JSON.parse(execFileSync(process.execPath, command, options));
    assert.equal(defaultResult.storage.worktrees.bytes, null, 'the CLI does not request a default size walk');
    const sizedResult = JSON.parse(execFileSync(process.execPath, [...command, '--sizes'], options));
    assert.equal(sizedResult.storage.worktrees.path, fixture.group);
    assert.ok(sizedResult.storage.worktrees.bytes > 0, '--sizes measures the target folder');
  } finally {
    process.env.SIDEQUEST_HOME = previousHome;
    fs.rmSync(fixture.repository, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
