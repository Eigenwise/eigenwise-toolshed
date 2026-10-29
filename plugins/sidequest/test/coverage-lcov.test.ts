import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const pluginRoot = path.resolve(process.cwd());

test('LCOV producer logs failing test names and writes LCOV', () => {
  const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-lcov-'));
  const fixturePath = path.join(fixtureDirectory, 'failing.test.js');
  const reportsDirectory = path.join(fixtureDirectory, 'reports');
  fs.writeFileSync(fixturePath, "import test from 'node:test';\ntest('named coverage failure', () => { throw new Error('expected fixture failure'); });\n");
  try {
    const result = spawnSync(process.execPath, ['scripts/coverage-lcov.mjs', fixturePath], {
      cwd: pluginRoot,
      encoding: 'utf8',
      env: { ...process.env, QUALITY_GATE_COVERAGE_DIR: reportsDirectory },
      timeout: 120000,
    });
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 1, output);
    const testLog = fs.readFileSync(path.join(reportsDirectory, 'coverage-tests.log'), 'utf8');
    assert.match(testLog, /named coverage failure/);
    assert.ok(fs.existsSync(path.join(reportsDirectory, 'lcov.info')));
  } finally {
    fs.rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});
