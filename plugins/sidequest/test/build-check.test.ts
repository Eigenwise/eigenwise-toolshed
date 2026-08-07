import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const pluginRoot = process.cwd();
function run(command: string, args: string[], cwd: string) {
  return spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true });
}

function createFixture() {
  const fixture = fs.mkdtempSync(path.join(pluginRoot, 'test', '.build-check-'));
  fs.mkdirSync(path.join(fixture, 'scripts'));
  fs.mkdirSync(path.join(fixture, 'src', 'hooks'), { recursive: true });
  fs.copyFileSync(path.join(pluginRoot, 'scripts', 'build.mjs'), path.join(fixture, 'scripts', 'build.mjs'));
  fs.copyFileSync(path.join(pluginRoot, 'scripts', 'build-check.mjs'), path.join(fixture, 'scripts', 'build-check.mjs'));
  fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({
    private: true,
    type: 'commonjs',
    scripts: { 'build:check': 'node scripts/build-check.mjs' },
  }));
  fs.writeFileSync(path.join(fixture, 'src', 'hooks', 'unexpected-hook.ts'), 'export const unexpected = true;\n');
  const initialize = run('git', ['init', '--quiet'], fixture);
  assert.equal(initialize.status, 0, initialize.stderr);
  return fixture;
}

test('build:check passes with correct uncommitted generated output', () => {
  const fixture = createFixture();
  try {
    const build = run(process.execPath, ['scripts/build.mjs'], fixture);
    assert.equal(build.status, 0, build.stderr);
    const generatedOutput = run('git', ['status', '--porcelain', '--untracked-files=all', '--', 'hooks'], fixture);
    assert.match(generatedOutput.stdout, /hooks[\\/]unexpected-hook\.js/);

    const result = run(process.execPath, ['scripts/build-check.mjs'], fixture);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('build:check reports generated output changed by the build', () => {
  const fixture = createFixture();
  try {
    const build = run(process.execPath, ['scripts/build.mjs'], fixture);
    assert.equal(build.status, 0, build.stderr);
    const add = run('git', ['add', '.'], fixture);
    assert.equal(add.status, 0, add.stderr);
    const commit = run('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--quiet', '-m', 'baseline'], fixture);
    assert.equal(commit.status, 0, commit.stderr);
    fs.writeFileSync(path.join(fixture, 'src', 'hooks', 'unexpected-hook.ts'), 'export const unexpected = false;\n');

    const result = run(process.execPath, ['scripts/build-check.mjs'], fixture);
    const output = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 1, output);
    assert.match(output, /Generated outputs changed during the build/);
    assert.match(output, /hooks[\\/]unexpected-hook\.js/);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
