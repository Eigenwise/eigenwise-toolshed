import test from 'node:test';
import assert from 'node:assert/strict';
import { worktreeRemovalFailureNotice } from '../src/hooks/shared/worktree-sweep.js';
import { deferralNotice } from '../src/hooks/shared/sweep-handoff.js';
const { worktreeSweepEntryLine } = require('../src/bin/sidequest-cmd-collaboration.ts');

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


test('deferred SessionStart sweep reports reached counts and the finishing command', () => {
  const notice = deferralNotice('C:/repo', {
    planned: 4,
    removed: 2,
    keptByReason: { legacy_unreclaimed: 1, active_ticket: 3 },
  });

  assert.match(notice, /Reached planned 4, removed 2, skipped 4 \(legacy_unreclaimed 1, active_ticket 3\)/);
  assert.match(notice, /worktrees sweep --yes --project/);
});
