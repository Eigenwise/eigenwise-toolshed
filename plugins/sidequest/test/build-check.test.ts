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
  const copiedScripts = ['build.mjs', 'build-check.mjs', 'generate-bundled-agents.mjs', 'owned-process-tree.js', 'owned-phase-supervisor.js', 'windows-job-owner.cs'];
  for (const script of copiedScripts) {
    fs.copyFileSync(path.join(pluginRoot, 'scripts', script), path.join(fixture, 'scripts', script));
  }
  fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({
    private: true,
    type: 'commonjs',
    scripts: { 'build:check': 'node scripts/build-check.mjs' },
  }));
  fs.writeFileSync(path.join(fixture, 'src', 'hooks', 'unexpected-hook.ts'), 'export const unexpected = true;\n');
  const initialize = run('git', ['init', '-b', 'main', '--quiet'], fixture);
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

test('a rebuild never truncates an output in place: unchanged bytes stay untouched, changed ones are swapped in whole', () => {
  const fixture = createFixture();
  try {
    fs.mkdirSync(path.join(fixture, 'src', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(fixture, 'src', 'lib', 'stable.ts'), 'export const stable = 1;\n');
    fs.writeFileSync(path.join(fixture, 'src', 'lib', 'edited.ts'), 'export const edited = 1;\n');
    const first = run(process.execPath, ['scripts/build.mjs'], fixture);
    assert.equal(first.status, 0, first.stderr);
    const stablePath = path.join(fixture, 'lib', 'stable.js');
    const editedPath = path.join(fixture, 'lib', 'edited.js');
    const stableBefore = fs.statSync(stablePath, { bigint: true });
    const editedBefore = fs.statSync(editedPath, { bigint: true });

    fs.writeFileSync(path.join(fixture, 'src', 'lib', 'edited.ts'), 'export const edited = 2;\n');
    const second = run(process.execPath, ['scripts/build.mjs'], fixture);
    assert.equal(second.status, 0, second.stderr);

    const stableAfter = fs.statSync(stablePath, { bigint: true });
    assert.equal(stableAfter.mtimeNs, stableBefore.mtimeNs, 'an unchanged output must not be rewritten');
    assert.equal(stableAfter.ino, stableBefore.ino, 'an unchanged output must keep its file identity');
    assert.match(fs.readFileSync(editedPath, 'utf8'), /edited = 2/);
    assert.notEqual(fs.statSync(editedPath, { bigint: true }).ino, editedBefore.ino, 'a changed output must be renamed into place, never truncated and rewritten');
    assert.deepEqual(fs.readdirSync(path.join(fixture, 'lib')).filter((name) => name.endsWith('.tmp')), [], 'no staged file is left behind');
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

function builtScripts(fixture: string) {
  const scripts = new Map<string, string>();
  for (const directory of ['lib', 'bin', 'hooks']) {
    const absolute = path.join(fixture, directory);
    if (!fs.existsSync(absolute)) continue;
    for (const file of fs.readdirSync(absolute, { recursive: true, encoding: 'utf8' })) {
      if (file.endsWith('.js')) scripts.set(path.join(directory, file), fs.readFileSync(path.join(absolute, file), 'utf8'));
    }
  }
  return scripts;
}

test('--sourcemap=external writes sibling maps with sourcesContent and leaves every .js byte-identical', () => {
  const fixture = createFixture();
  try {
    const widgetSource = 'export function widget(value: number): number {\n  return value + 1;\n}\n';
    fs.mkdirSync(path.join(fixture, 'src', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(fixture, 'src', 'lib', 'widget.ts'), widgetSource);
    const plain = run(process.execPath, ['scripts/build.mjs'], fixture);
    assert.equal(plain.status, 0, plain.stderr);
    const committedScripts = builtScripts(fixture);
    assert.ok(committedScripts.has(path.join('lib', 'widget.js')));

    const mapped = run(process.execPath, ['scripts/build.mjs', '--sourcemap=external'], fixture);
    assert.equal(mapped.status, 0, mapped.stderr);
    assert.deepEqual(builtScripts(fixture), committedScripts);
    for (const script of committedScripts.keys()) assert.ok(fs.existsSync(path.join(fixture, `${script}.map`)), `${script}.map`);
    const map = JSON.parse(fs.readFileSync(path.join(fixture, 'lib', 'widget.js.map'), 'utf8'));
    assert.equal(map.version, 3);
    assert.deepEqual(map.sourcesContent, [widgetSource]);
    assert.equal(path.resolve(fixture, 'lib', map.sources[0]), path.join(fixture, 'src', 'lib', 'widget.ts'));
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
