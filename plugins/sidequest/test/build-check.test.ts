import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const pluginRoot = process.cwd();
function run(command: string, args: string[], cwd: string) {
  return spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true });
}

test('build:check reports untracked generated output', () => {
  const fixture = fs.mkdtempSync(path.join(pluginRoot, 'test', '.build-check-'));
  try {
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

    const result = run(process.execPath, ['scripts/build-check.mjs'], fixture);
    const output = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 1, output);
    assert.match(output, /Generated outputs differ from the repository/);
    assert.match(output, /hooks[\\/]unexpected-hook\.js/);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
