'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const commitScope = require('../lib/commit-scope');

function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
}

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-commit-scope-'));
  git(root, ['init']);
  git(root, ['config', 'user.name', 'Sidequest Test']);
  git(root, ['config', 'user.email', 'sidequest-test@example.invalid']);
  fs.mkdirSync(path.join(root, 'plugins', 'sidequest'), { recursive: true });
  fs.mkdirSync(path.join(root, 'plugins', 'switchboard'), { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), 'base\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'base']);
  return root;
}

test('scoped commit leaves another executor’s staged file in the shared index', () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'plugins', 'sidequest', 'worker-a.js'), 'a\n');
  fs.writeFileSync(path.join(root, 'plugins', 'switchboard', 'worker-b.js'), 'b\n');
  git(root, ['add', '.']);

  const committed = commitScope.commitScoped(root, 'worker a', ['plugins/sidequest']);
  assert.equal(committed.ok, true);
  assert.deepEqual(committed.paths, ['plugins/sidequest/worker-a.js']);
  assert.equal(git(root, ['diff', '--cached', '--name-only']), 'plugins/switchboard/worker-b.js');
  assert.deepEqual(commitScope.commitPaths(root, committed.commit), ['plugins/sidequest/worker-a.js']);
});

test('out-of-scope commits are refused before submission', () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'plugins', 'sidequest', 'worker-a.js'), 'a\n');
  fs.writeFileSync(path.join(root, 'plugins', 'switchboard', 'worker-b.js'), 'b\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'contaminated']);

  const verdict = commitScope.validateCommitScope(root, 'HEAD', ['plugins/sidequest']);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'outside_scope');
  assert.deepEqual(verdict.outside, ['plugins/switchboard/worker-b.js']);
});
