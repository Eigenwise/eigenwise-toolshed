import test from 'node:test';
import assert from 'node:assert/strict';
import { worktreeRemovalFailureNotice } from '../src/hooks/shared/worktree-sweep.js';

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
