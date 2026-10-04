import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { selectAffectedPlugins } from '../lib/affected-suites.mjs';
import { MARKETPLACE_PATH, readManifest } from '../lib/manifests.mjs';
import { marketplaceJson } from './helpers.mjs';
import { makeGitRepo } from './realrepo.mjs';

const PLUGINS = { sidequest: '3.6.17', workbench: '0.63.6' };
const ALL_PLUGINS = Object.keys(PLUGINS);
const workflow = readFileSync(new URL('../../../.github/workflows/test.yml', import.meta.url), 'utf8');

function selectionInput(changed, marketplace = marketplaceJson({ version: '3.207.0', plugins: PLUGINS })) {
  const files = Object.fromEntries(Object.entries(PLUGINS).map(([name, version]) => [
    `plugins/${name}/.claude-plugin/plugin.json`, JSON.stringify({ name, version }),
  ]));
  const before = { ...files, [MARKETPLACE_PATH]: marketplaceJson({ version: '3.207.0', plugins: PLUGINS }) };
  const source = { label: 'head', read: (file) => ({ ...files, [MARKETPLACE_PATH]: marketplace })[file] ?? null };
  return {
    base: 'base',
    head: 'head',
    manifest: readManifest(source),
    git: {
      revParse: (revision) => revision,
      treeEntry: () => ({ type: 'blob', mode: '100644', object: 'fixture' }),
      showFile: (revision, file) => before[file] ?? null,
      invoke: (args) => {
        assert.deepEqual(args, ['diff', '--no-renames', '--name-only', '-z', 'base', 'head', '--']);
        return { stdout: changed.map((file) => `${file}\0`).join('') };
      },
    },
  };
}

function matrixRun(repo, base) {
  const script = /node --input-type=module - >> "\$GITHUB_OUTPUT" <<'NODE'\n([\s\S]*?)\n\s+NODE/.exec(workflow)?.[1];
  assert.ok(script, 'the workflow runs the matrix selection script');
  const imports = script.replaceAll("'./scripts/release/lib/", `'${new URL('../lib/', import.meta.url).href}`);
  return spawnSync(process.execPath, ['--input-type=module', '-e', imports], {
    cwd: repo.root,
    env: { ...process.env, BASE_SHA: base, GITHUB_SHA: repo.git('rev-parse', 'HEAD') },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
  });
}

test('marketplace version and release-owned metadata avoid unrelated full suites', () => {
  const input = selectionInput(
    [MARKETPLACE_PATH, 'CHANGELOG.md', 'scripts/release/README.md', '.release/unreleased/SQ-3315.md'],
    marketplaceJson({ version: '3.208.0', plugins: PLUGINS }),
  );
  assert.deepEqual(selectAffectedPlugins(input), []);
  assert.deepEqual(selectAffectedPlugins(selectionInput([])), []);
});

test('every plugin runtime, test, dependency and agent surface retains its own full suite', () => {
  for (const file of [
    'src/lib/store.ts', 'lib/store.js', 'test/store.test.ts', 'test/fixtures/input.json',
    'package.json', 'package-lock.json', 'hooks/hooks.json', 'skills/sidequest/SKILL.md',
    'agents/executor.md', '.claude-plugin/plugin.json', 'README.md', 'CHANGELOG.md',
  ]) {
    assert.deepEqual(selectAffectedPlugins(selectionInput([`plugins/sidequest/${file}`])), ['sidequest'], file);
  }
  assert.deepEqual(selectAffectedPlugins(selectionInput(['plugins/workbench/index.js'])), ['workbench']);
  assert.deepEqual(selectAffectedPlugins(selectionInput(['plugins/sidequest/lib/store.js', 'plugins/sidequest/test/store.test.ts'])), ['sidequest']);
});

test('shared runners, test workflow and unknown paths conservatively select every suite', () => {
  for (const file of [
    'scripts/release/lib/suites.mjs', 'scripts/release/test/plan.test.mjs',
    '.github/workflows/test.yml', '.github/workflows/new.yml', 'scripts/test-runner.mjs',
    'plugins/sidequest/lib/suite-resolver.js', 'plugins/sidequest/src/lib/suite-resolver.ts',
    'plugins/new-plugin/index.js', 'unclassified.txt', 'scripts/release/SKILL.md',
  ]) {
    assert.deepEqual(selectAffectedPlugins(selectionInput([file])), ALL_PLUGINS, file);
  }
});

test('marketplace runtime configuration, source rebinding and plugin membership changes select all suites', () => {
  for (const change of [
    (marketplace) => { marketplace.description = 'changed'; },
    (marketplace) => { marketplace.plugins[0].source = './plugins/renamed'; },
    (marketplace) => { marketplace.plugins.pop(); },
    (marketplace) => { marketplace.plugins.push({ name: 'new-plugin', source: './plugins/new-plugin', version: '1.0.0' }); },
    (marketplace) => { marketplace.plugins.reverse(); },
  ]) {
    const marketplace = JSON.parse(marketplaceJson({ version: '3.207.0', plugins: PLUGINS }));
    change(marketplace);
    const input = selectionInput([MARKETPLACE_PATH], JSON.stringify(marketplace));
    assert.deepEqual(selectAffectedPlugins(input), [...input.manifest.plugins.keys()]);
  }
});

test('missing or unreadable base and failed diff retain full verification', () => {
  const missing = selectionInput([]);
  missing.git.revParse = () => { throw new Error('missing revision'); };
  assert.deepEqual(selectAffectedPlugins(missing), ALL_PLUGINS);
  const unreadable = selectionInput([]);
  unreadable.git.showFile = () => null;
  assert.deepEqual(selectAffectedPlugins(unreadable), ALL_PLUGINS);
  const invalid = selectionInput([]);
  invalid.git.showFile = (revision, file) => file === MARKETPLACE_PATH
    ? marketplaceJson({ version: 'invalid', plugins: PLUGINS })
    : JSON.stringify({ version: '3.6.17' });
  assert.deepEqual(selectAffectedPlugins(invalid), ALL_PLUGINS);
  const failedDiff = selectionInput([]);
  failedDiff.git.invoke = () => { throw new Error('diff failed'); };
  assert.deepEqual(selectAffectedPlugins(failedDiff), ALL_PLUGINS);
});

test('metadata symlinks, executable modes and unreadable tree entries keep full verification', () => {
  for (const entry of [undefined, { type: 'tree', mode: '040000' }, { type: 'blob', mode: '120000' }, { type: 'blob', mode: '100755' }]) {
    const input = selectionInput(['scripts/release/README.md']);
    input.git.treeEntry = () => entry;
    assert.deepEqual(selectAffectedPlugins(input), ALL_PLUGINS);
  }
  const addedOrDeleted = selectionInput(['.release/unreleased/SQ-3315.md']);
  addedOrDeleted.git.treeEntry = (revision) => revision === 'base' ? null : { type: 'blob', mode: '100644' };
  assert.deepEqual(selectAffectedPlugins(addedOrDeleted), []);
});

test('a metadata push still selects source changed against the target base', () => {
  assert.deepEqual(selectAffectedPlugins(selectionInput([
    'scripts/release/README.md', 'plugins/sidequest/src/lib/store.ts',
  ])), ['sidequest']);
});

test('workflow executes focused metadata validation and preserves both OS suite commands', (context) => {
  const repo = makeGitRepo({ plugins: PLUGINS });
  context.after(repo.cleanup);
  const base = repo.git('rev-parse', 'HEAD');
  repo.write(MARKETPLACE_PATH, marketplaceJson({ version: '3.208.0', plugins: PLUGINS }));
  repo.commit('marketplace version');
  const result = matrixRun(repo, base);
  assert.equal(result.status, 0, result.stderr);
  const matrix = JSON.parse(result.stdout.trim().slice('matrix='.length));
  assert.equal(matrix.include.length, 4);
  for (const entry of matrix.include) {
    assert.equal(entry.affected, false);
    assert.equal(entry.command, 'node --test --test-timeout=120000 "test/*.test.js"');
    assert.equal(entry.setup, '');
  }
  assert.deepEqual(matrix.include.map(({ os }) => os), ['ubuntu-latest', 'windows-latest', 'ubuntu-latest', 'windows-latest']);
  repo.write('plugins/sidequest/.claude-plugin/plugin.json', JSON.stringify({ name: 'sidequest', version: '3.6.18' }));
  repo.write(MARKETPLACE_PATH, marketplaceJson({ version: '3.208.0', plugins: { ...PLUGINS, sidequest: '3.6.18' } }));
  repo.commit('runtime consumed plugin version');
  const bumped = matrixRun(repo, base);
  assert.equal(bumped.status, 0, bumped.stderr);
  assert.deepEqual(JSON.parse(bumped.stdout.trim().slice('matrix='.length)).include.map(({ affected }) => affected), [true, true, false, false]);
});

test('invalid manifest and release fragment fail the matrix even when no full suite is selected', (context) => {
  const repo = makeGitRepo({ plugins: PLUGINS });
  context.after(repo.cleanup);
  const base = repo.git('rev-parse', 'HEAD');
  repo.write(MARKETPLACE_PATH, marketplaceJson({ version: 'invalid', plugins: PLUGINS }));
  repo.commit('invalid marketplace metadata');
  const invalidManifest = matrixRun(repo, base);
  assert.equal(invalidManifest.status, 1);
  assert.match(invalidManifest.stderr, /top-level version.*not a plain x\.y\.z semver/);
  repo.write(MARKETPLACE_PATH, marketplaceJson({ version: '3.208.0', plugins: PLUGINS }));
  repo.write('.release/unreleased/SQ-3315.md', 'invalid fragment');
  repo.commit('invalid release fragment');
  const invalidFragment = matrixRun(repo, base);
  assert.equal(invalidFragment.status, 1);
  assert.match(invalidFragment.stderr, /SQ-3315\.md: missing opening/);
  const aggregateScript = /node -e '([\s\S]*?)\n *'/.exec(workflow)?.[1];
  assert.ok(aggregateScript);
  const aggregate = spawnSync(process.execPath, ['-e', aggregateScript], {
    env: { ...process.env, RESULTS: JSON.stringify({
      'release-engine': { result: 'success' },
      'plugin-matrix': { result: 'failure' },
      'affected-plugin': { result: 'skipped' },
    }) },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
  });
  assert.equal(aggregate.status, 1, 'focused metadata failure fails test-complete');
});
