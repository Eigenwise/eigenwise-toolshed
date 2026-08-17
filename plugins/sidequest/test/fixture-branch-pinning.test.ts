import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const GIT_INIT = /(['"])init\1/;
const PINS_BRANCH = /'-b'|"-b"|--initial-branch/;
const ALLOWANCE = /unpinned-initial-branch:/;

// `git init` takes its branch name from init.defaultBranch, and the full suite runs with global and system
// config nulled out, so the same fixture starts on main under `test:files` and master under `test:full`. A
// fixture that later names a branch then does not fail cleanly: `git checkout main` with no local main and an
// origin/main present invents a local branch tracking the remote, so the assertion runs against a tree the
// fixture never built (SQ-2089, two full-gate failures whose only output was two unexplained shas).
test('SQ-2201: every git fixture pins the initial branch name', () => {
  const directory = __dirname;
  const unpinned: string[] = [];
  for (const entry of fs.readdirSync(directory).sort()) {
    if (!/\.test\.(ts|js)$/.test(entry)) continue;
    const lines = fs.readFileSync(path.join(directory, entry), 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (!/git/i.test(line) || !GIT_INIT.test(line) || PINS_BRANCH.test(line)) return;
      if (ALLOWANCE.test(line) || ALLOWANCE.test(lines[index - 1] || '')) return;
      unpinned.push(`${entry}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(
    unpinned,
    [],
    `these git fixtures inherit whatever branch name the ambient config gives them, which differs between \`npm run test:files\` and \`npm run test:full\`. Pass \`'-b', 'main'\` to git init. If a test is deliberately about the unconfigured default, put \`unpinned-initial-branch: <why>\` in a comment on that line or the line above it.\n${unpinned.join('\n')}`,
  );
});
