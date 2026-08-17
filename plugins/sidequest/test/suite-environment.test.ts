import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('full suite runs without ambient git configuration', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'sidequest-suite-env-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  assert.equal(process.env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(process.env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(process.env.GIT_CONFIG_GLOBAL, process.platform === 'win32' ? 'NUL' : '/dev/null');
  assert.equal(process.env.GIT_CONFIG_SYSTEM, process.platform === 'win32' ? 'NUL' : '/dev/null');
  // unpinned-initial-branch: this assertion is the proof that no default branch is configured here.
  execFileSync('git', ['init', '--quiet'], { cwd: root, windowsHide: true });
  assert.equal(execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim(), 'master');
});
