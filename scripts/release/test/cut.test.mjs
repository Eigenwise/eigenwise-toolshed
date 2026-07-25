import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { cut } from '../cut.mjs';
import { createGit } from '../lib/git.mjs';
import { readValue } from '../lib/jsonedit.mjs';
import { DEFAULT_DATE, DEFAULT_SHA, fragmentText, makeRepo, recordingGit, remoteMutations } from './helpers.mjs';

const PLUGINS = { 'codex-gateway': '0.33.4', sidequest: '3.6.17', workbench: '0.63.6' };

function setup(t, { gitOptions = {}, suiteExit = 0, ...repoOptions } = {}) {
  const repo = makeRepo({ plugins: PLUGINS, ...repoOptions });
  t.after(repo.cleanup);
  const { run, calls } = recordingGit(gitOptions);
  const suites = [];
  return {
    root: repo.root,
    calls,
    suites,
    git: createGit({ cwd: repo.root, run }),
    runSuite: (suite) => {
      suites.push(suite.plugin);
      return { code: suiteExit, command: suite.command };
    },
    read: (relative) => readFileSync(path.join(repo.root, relative), 'utf8'),
    exists: (relative) => existsSync(path.join(repo.root, relative)),
    version: (name) => readValue(readFileSync(path.join(repo.root, `plugins/${name}/.claude-plugin/plugin.json`), 'utf8'), ['version']),
    entryVersion: (name) => {
      const text = readFileSync(path.join(repo.root, '.claude-plugin/marketplace.json'), 'utf8');
      return JSON.parse(text).plugins.find((entry) => entry.name === name).version;
    },
    marketplaceVersion: () => JSON.parse(readFileSync(path.join(repo.root, '.claude-plugin/marketplace.json'), 'utf8')).version,
  };
}

test('a normal cut moves three version fields and nothing else', async (t) => {
  const context = setup(t, {
    fragments: {
      'SQ-1': { plugins: ['sidequest'], bump: 'patch', commit: 'aaaaaaa' },
      'SQ-2': { plugins: ['sidequest'], bump: 'minor', commit: 'bbbbbbb' },
      'SQ-3': { plugins: ['workbench'], bump: 'patch', commit: 'ccccccc' },
    },
    suites: { sidequest: 'package', workbench: 'testdir' },
  });

  const result = await cut({ repoRoot: context.root, git: context.git, runSuite: context.runSuite, log: () => {} });

  assert.equal(result.status, 'cut');
  assert.equal(context.version('sidequest'), '3.7.0');
  assert.equal(context.entryVersion('sidequest'), '3.7.0');
  assert.equal(context.version('workbench'), '0.63.7');
  assert.equal(context.entryVersion('workbench'), '0.63.7');
  assert.equal(context.marketplaceVersion(), '3.208.0');
  assert.equal(context.version('codex-gateway'), '0.33.4', 'an untouched plugin never moves');
  assert.equal(context.entryVersion('codex-gateway'), '0.33.4');
  assert.deepEqual(context.suites, ['sidequest', 'workbench']);
});

test('a cut generates the changelogs and consumes the fragments it used', async (t) => {
  const context = setup(t, {
    fragments: {
      'SQ-1': { plugins: ['sidequest'], bump: 'minor', commit: 'aaaaaaa' },
      'SQ-2': { plugins: ['workbench'], bump: 'patch', commit: 'bbbbbbb', hold: true },
    },
  });

  const result = await cut({ repoRoot: context.root, git: context.git, runSuite: () => ({ code: 0 }), log: () => {} });

  const repoChangelog = context.read('CHANGELOG.md');
  assert.match(repoChangelog, /^## v3\.208\.0 \(2026-07-25\)$/m);
  assert.match(repoChangelog, /### sidequest 3\.6\.17 → 3\.7\.0/);
  assert.doesNotMatch(repoChangelog, /SQ-2/, 'a held fragment is not in the changelog');
  assert.match(context.read('plugins/sidequest/CHANGELOG.md'), /^## 3\.7\.0 \(2026-07-25\)$/m);
  assert.equal(context.exists('plugins/workbench/CHANGELOG.md'), false, 'untouched plugins get no changelog');

  assert.equal(context.exists('.release/unreleased/SQ-1.md'), false, 'consumed');
  assert.equal(context.exists('.release/unreleased/SQ-2.md'), true, 'held fragments survive the cut');
  assert.deepEqual(result.consumed, ['.release/unreleased/SQ-1.md']);
});

test('rerunning the same cut releases nothing', async (t) => {
  const context = setup(t, { fragments: { 'SQ-1': { plugins: ['sidequest'], bump: 'patch', commit: 'aaaaaaa' } } });

  await cut({ repoRoot: context.root, git: context.git, runSuite: () => ({ code: 0 }), log: () => {} });
  const before = context.read('CHANGELOG.md');

  const again = await cut({ repoRoot: context.root, git: context.git, runSuite: () => ({ code: 0 }), log: () => {} });
  assert.equal(again.status, 'nothing-to-release');
  assert.equal(context.version('sidequest'), '3.6.18', 'the second run does not double-bump');
  assert.equal(context.marketplaceVersion(), '3.208.0');
  assert.equal(context.read('CHANGELOG.md'), before);
});

test('a queued fragment for an already-released ref cannot ship twice', async (t) => {
  const context = setup(t, {
    fragments: { 'SQ-1': { plugins: ['sidequest'], bump: 'patch', commit: 'aaaaaaa' } },
    changelog: '# Changelog\n\n## v3.207.0 (2026-07-24)\n\n### sidequest 3.6.16 → 3.6.17\n\n#### Fixes\n- Already out (SQ-1)\n',
  });

  const result = await cut({ repoRoot: context.root, git: context.git, runSuite: () => ({ code: 0 }), log: () => {} });
  assert.equal(result.status, 'nothing-to-release');
  assert.equal(context.version('sidequest'), '3.6.17');
});

test('a dry run writes nothing and mutates no ref', async (t) => {
  const context = setup(t, { fragments: { 'SQ-1': { plugins: ['sidequest'], bump: 'minor', commit: 'aaaaaaa' } } });

  const result = await cut({ repoRoot: context.root, git: context.git, dryRun: true, runSuite: () => ({ code: 0 }), log: () => {} });

  assert.equal(result.status, 'dry-run');
  assert.equal(result.plan.plugins[0].to, '3.7.0');
  assert.equal(context.version('sidequest'), '3.6.17');
  assert.equal(context.exists('.release/unreleased/SQ-1.md'), true);
  assert.equal(context.exists('CHANGELOG.md'), false);
  assert.deepEqual(context.calls.filter((call) => /^(merge|commit|tag -a|push|cherry-pick|add)/.test(call)), []);
});

test('.release/HOLD stops a normal window and --force overrides it', async (t) => {
  const context = setup(t, {
    fragments: { 'SQ-1': { plugins: ['sidequest'], bump: 'patch', commit: 'aaaaaaa' } },
    hold: 'waiting on the docs ticket',
  });

  const held = await cut({ repoRoot: context.root, git: context.git, runSuite: () => ({ code: 0 }), log: () => {} });
  assert.equal(held.status, 'held');
  assert.equal(held.reason, 'waiting on the docs ticket');
  assert.equal(context.version('sidequest'), '3.6.17');

  const forced = await cut({ repoRoot: context.root, git: context.git, force: true, runSuite: () => ({ code: 0 }), log: () => {} });
  assert.equal(forced.status, 'cut');
  assert.equal(context.version('sidequest'), '3.6.18');
});

test('a hold committed on the integration branch stops the cut before the merge', async (t) => {
  const context = setup(t, {
    fragments: { 'SQ-1': { plugins: ['sidequest'], bump: 'patch', commit: 'aaaaaaa' } },
    gitOptions: { files: { '.release/HOLD': 'paused from dev\n' } },
  });

  const held = await cut({ repoRoot: context.root, git: context.git, runSuite: () => ({ code: 0 }), log: () => {} });
  assert.equal(held.status, 'held');
  assert.equal(held.reason, 'paused from dev');
  assert.deepEqual(context.calls.filter((call) => call.startsWith('merge')), [], 'nothing was merged');
});

test('an existing tag stops the cut instead of moving it', async (t) => {
  const context = setup(t, {
    fragments: { 'SQ-1': { plugins: ['sidequest'], bump: 'patch', commit: 'aaaaaaa' } },
    gitOptions: { tags: ['v3.208.0'] },
  });

  await assert.rejects(
    () => cut({ repoRoot: context.root, git: context.git, runSuite: () => ({ code: 0 }), log: () => {} }),
    /these tags already exist.*v3\.208\.0/s,
  );
  assert.equal(context.version('sidequest'), '3.6.17');
});

test('a plugin whose manifest and marketplace entry disagree blocks the cut', async (t) => {
  const context = setup(t, { fragments: { 'SQ-1': { plugins: ['sidequest'], bump: 'patch', commit: 'aaaaaaa' } } });
  const manifestPath = path.join(context.root, 'plugins/sidequest/.claude-plugin/plugin.json');
  writeFileSync(manifestPath, readFileSync(manifestPath, 'utf8').replace('3.6.17', '3.6.12'));

  await assert.rejects(
    () => cut({ repoRoot: context.root, git: context.git, runSuite: () => ({ code: 0 }), log: () => {} }),
    /version mismatch.*marketplace\.json says 3\.6\.17.*says 3\.6\.12/s,
  );
});

test('a hotfix cherry-picks only its tickets and patch-bumps only their plugins', async (t) => {
  const files = {
    '.release/unreleased/SQ-1.md': fragmentText('SQ-1', { plugins: ['sidequest'], bump: 'minor', commit: 'aaaaaaa' }),
    '.release/unreleased/SQ-2.md': fragmentText('SQ-2', { plugins: ['workbench'], bump: 'minor', commit: 'bbbbbbb' }),
  };
  const context = setup(t, { gitOptions: { files } });

  const result = await cut({
    repoRoot: context.root,
    git: context.git,
    mode: 'hotfix',
    tickets: ['SQ-2'],
    runSuite: () => ({ code: 0 }),
    log: () => {},
  });

  assert.equal(result.status, 'cut');
  assert.deepEqual(context.calls.filter((call) => call.startsWith('cherry-pick')), ['cherry-pick -x bbbbbbb']);
  assert.equal(context.version('workbench'), '0.64.0');
  assert.equal(context.version('sidequest'), '3.6.17', 'the unreleased ticket stays unreleased');
  assert.equal(context.marketplaceVersion(), '3.207.1');
  assert.equal(result.plan.tag, 'v3.207.1');
  assert.deepEqual(result.plan.tags, ['v3.207.1', 'workbench-v0.64.0']);
  assert.match(context.read('CHANGELOG.md'), /Hotfix release cut from `main`/);
});

test('a hotfix skips a cherry-pick that main already contains', async (t) => {
  const context = setup(t, {
    gitOptions: {
      files: { '.release/unreleased/SQ-2.md': fragmentText('SQ-2', { plugins: ['workbench'], bump: 'patch', commit: 'bbbbbbb' }) },
      ancestors: ['bbbbbbb'],
    },
  });

  await cut({ repoRoot: context.root, git: context.git, mode: 'hotfix', tickets: ['SQ-2'], runSuite: () => ({ code: 0 }), log: () => {} });
  assert.deepEqual(context.calls.filter((call) => call.startsWith('cherry-pick')), []);
  assert.equal(context.version('workbench'), '0.63.7');
});

test('the cut refuses a dirty tree and the wrong branch', async (t) => {
  const dirty = setup(t, {
    fragments: { 'SQ-1': { plugins: ['sidequest'], bump: 'patch', commit: 'aaaaaaa' } },
    gitOptions: { clean: false },
  });
  await assert.rejects(() => cut({ repoRoot: dirty.root, git: dirty.git, log: () => {} }), /uncommitted changes/);

  const wrongBranch = setup(t, {
    fragments: { 'SQ-1': { plugins: ['sidequest'], bump: 'patch', commit: 'aaaaaaa' } },
    gitOptions: { branch: 'dev' },
  });
  await assert.rejects(() => cut({ repoRoot: wrongBranch.root, git: wrongBranch.git, log: () => {} }), /cutting from "dev"/);
});

test('the release commit and tags carry the window, the plugins, and the refs', async (t) => {
  const context = setup(t, {
    fragments: {
      'SQ-1': { plugins: ['sidequest'], bump: 'minor', commit: 'aaaaaaa' },
      'SQ-2': { plugins: ['workbench'], bump: 'patch', commit: 'bbbbbbb' },
    },
  });

  const result = await cut({ repoRoot: context.root, git: context.git, runSuite: () => ({ code: 0 }), log: () => {} });

  assert.equal(result.message, 'release v3.208.0: sidequest 3.7.0, workbench 0.63.7 (SQ-1, SQ-2)');
  assert.deepEqual(context.calls.filter((call) => call.startsWith('tag -a')), [
    'tag -a v3.208.0 -m release v3.208.0: sidequest 3.7.0, workbench 0.63.7 (SQ-1, SQ-2)',
    'tag -a sidequest-v3.7.0 -m sidequest 3.7.0 (v3.208.0)',
    'tag -a workbench-v0.63.7 -m workbench 0.63.7 (v3.208.0)',
  ]);
  const staged = context.calls.find((call) => call.startsWith('add --'));
  for (const file of [
    '.claude-plugin/marketplace.json',
    'plugins/sidequest/.claude-plugin/plugin.json',
    'plugins/workbench/.claude-plugin/plugin.json',
    'CHANGELOG.md',
    'plugins/sidequest/CHANGELOG.md',
    'plugins/workbench/CHANGELOG.md',
    '.release/unreleased/SQ-1.md',
    '.release/unreleased/SQ-2.md',
  ]) {
    assert.ok(staged.includes(file), `expected ${file} in "${staged}"`);
  }
  assert.deepEqual(remoteMutations(context.calls), [], 'building a cut never touches a remote');
  assert.equal(result.pushCommand, 'git push --atomic origin HEAD:main v3.208.0 sidequest-v3.7.0 workbench-v0.63.7');
  assert.equal(result.commit, DEFAULT_SHA);
  assert.equal(result.plan.date, DEFAULT_DATE);
});
