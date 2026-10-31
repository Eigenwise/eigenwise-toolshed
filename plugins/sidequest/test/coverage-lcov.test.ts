import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const pluginRoot = path.resolve(process.cwd());

// The producer rebuilds the plugin it lives in. Run against the live checkout, that rewrote
// lib/bin/hooks while concurrent suites required them (SQ-4018), so it runs from a copy. The copy
// sits under test/ so esbuild and tsx still resolve from this plugin's node_modules.
function createProducerFixture() {
  const fixture = fs.mkdtempSync(path.join(pluginRoot, 'test', '.coverage-lcov-'));
  const copied = [
    'scripts/coverage-lcov.mjs', 'scripts/build.mjs', 'scripts/generate-bundled-agents.mjs',
    'scripts/owned-process-tree.js', 'scripts/owned-phase-supervisor.js', 'scripts/windows-job-owner.cs',
    'lib/ports/process.js', 'test/_sidequest-test-home.ts', 'test/_hook-runtime.ts',
  ];
  for (const file of copied) {
    fs.mkdirSync(path.dirname(path.join(fixture, file)), { recursive: true });
    fs.copyFileSync(path.join(pluginRoot, file), path.join(fixture, file));
  }
  fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ private: true, type: 'commonjs' }));
  return fixture;
}

test('LCOV producer logs failing test names and writes LCOV', () => {
  const fixture = createProducerFixture();
  const fixturePath = path.join(fixture, 'failing.test.js');
  const reportsDirectory = path.join(fixture, 'reports');
  fs.writeFileSync(fixturePath, "import test from 'node:test';\ntest('named coverage failure', () => { throw new Error('expected fixture failure'); });\n");
  try {
    const result = spawnSync(process.execPath, ['scripts/coverage-lcov.mjs', fixturePath], {
      cwd: fixture,
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
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
