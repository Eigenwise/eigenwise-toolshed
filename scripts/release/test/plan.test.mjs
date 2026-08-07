import assert from 'node:assert/strict';
import test from 'node:test';

import { readRepoChangelog, releasedFragmentFingerprints } from '../lib/changelog.mjs';
import { readFragments } from '../lib/fragments.mjs';
import { readManifest } from '../lib/manifests.mjs';
import { buildPlan, formatPlan, planCommitMessage, planPushCommand, PlanError } from '../lib/plan.mjs';
import { createSuiteResolver } from '../lib/suites.mjs';
import { diskSource } from '../lib/treesource.mjs';
import { DEFAULT_DATE, DEFAULT_SHA, makeRepo } from './helpers.mjs';

const PLUGINS = { 'codebase-mapper': '2.11.1', 'codex-gateway': '0.33.4', sidequest: '3.6.17', workbench: '0.63.6' };

function planFor(t, { fragments = {}, changelog = null, plugins = PLUGINS, suites = {}, ...options } = {}) {
  const repo = makeRepo({ plugins, fragments, changelog, suites });
  t.after(repo.cleanup);
  const source = diskSource(repo.root);
  const manifest = readManifest(source, repo.root);
  const { fragments: parsed, errors } = readFragments(source, { knownPlugins: manifest.plugins });
  assert.deepEqual(errors.map((error) => error.message), []);
  return buildPlan({
    fragments: parsed,
    manifest,
    date: DEFAULT_DATE,
    sha: DEFAULT_SHA,
    released: releasedFragmentFingerprints(readRepoChangelog(source)),
    suiteResolver: createSuiteResolver(repo.root),
    ...options,
  });
}

test('a window takes the highest level per plugin and leaves everything else alone', (t) => {
  const plan = planFor(t, {
    fragments: {
      'SQ-1': { plugins: ['sidequest'], bump: 'patch' },
      'SQ-2': { plugins: ['sidequest'], bump: 'minor' },
      'SQ-3': { plugins: ['sidequest'], bump: 'patch' },
      'SQ-4': { plugins: ['workbench'], bump: 'patch' },
    },
  });

  assert.deepEqual(plan.plugins.map((plugin) => [plugin.name, plugin.level, plugin.from, plugin.to]), [
    ['sidequest', 'minor', '3.6.17', '3.7.0'],
    ['workbench', 'patch', '0.63.6', '0.63.7'],
  ]);
  assert.deepEqual(plan.plugins.map((plugin) => plugin.name), ['sidequest', 'workbench']);
  assert.equal(plan.plugins.find((plugin) => plugin.name === 'codex-gateway'), undefined, 'untouched plugins never move');
});

test('one fragment can bump several plugins at different levels', (t) => {
  const plan = planFor(t, {
    fragments: { 'SQ-1': { plugins: { sidequest: 'minor', workbench: 'patch', 'codex-gateway': 'major' } } },
  });
  assert.deepEqual(plan.plugins.map((plugin) => `${plugin.name} ${plugin.from}->${plugin.to}`), [
    'codex-gateway 0.33.4->1.0.0',
    'sidequest 3.6.17->3.7.0',
    'workbench 0.63.6->0.63.7',
  ]);
});

test('the marketplace counter takes a minor per window and a patch per hotfix', (t) => {
  const fragments = { 'SQ-1': { plugins: ['sidequest'], bump: 'patch', commit: 'abcdef1' } };
  const normal = planFor(t, { fragments });
  assert.deepEqual(normal.marketplace, { from: '3.207.0', to: '3.208.0', level: 'minor' });
  assert.deepEqual(normal.tags, ['v3.208.0', 'sidequest-v3.6.18']);

  const hotfix = planFor(t, { fragments, mode: 'hotfix', tickets: ['SQ-1'] });
  assert.deepEqual(hotfix.marketplace, { from: '3.207.0', to: '3.207.1', level: 'patch' });
  assert.deepEqual(hotfix.tags, ['v3.207.1', 'sidequest-v3.6.18']);
});

test('held fragments stay out of a normal window', (t) => {
  const plan = planFor(t, {
    fragments: {
      'SQ-1': { plugins: ['sidequest'], bump: 'patch' },
      'SQ-2': { plugins: ['workbench'], bump: 'minor', hold: true },
    },
  });
  assert.deepEqual(plan.selected.map((fragment) => fragment.ref), ['SQ-1']);
  assert.deepEqual(plan.skipped, [{ ref: 'SQ-2', reason: 'held by "hold: true"' }]);
  assert.deepEqual(plan.plugins.map((plugin) => plugin.name), ['sidequest']);
});

test('a window with nothing but held fragments releases nothing', (t) => {
  const plan = planFor(t, { fragments: { 'SQ-1': { plugins: ['sidequest'], bump: 'patch', hold: true } } });
  assert.equal(plan.releasable, false);
  assert.deepEqual(plan.tags, []);
  assert.equal(plan.marketplace.to, '3.207.0', 'the counter does not move when nothing ships');
  assert.match(formatPlan(plan), /nothing to release/);
});

test('an exact fragment already in the changelog never ships twice', (t) => {
  const plan = planFor(t, {
    fragments: { 'SQ-1': { title: 'SQ-1 title', plugins: ['sidequest'], bump: 'patch' }, 'SQ-2': { plugins: ['workbench'], bump: 'patch' } },
    changelog: '# Changelog\n\n## v3.207.1 (2026-07-24)\n\n### sidequest 3.6.16 → 3.6.17\n\n#### Fixes\n- SQ-1 title (SQ-1)\n',
  });
  assert.deepEqual(plan.selected.map((fragment) => fragment.ref), ['SQ-2']);
  assert.deepEqual(plan.skipped, [{ ref: 'SQ-1', reason: 'already released (same fragment content is in CHANGELOG.md; this queued copy is stuck and its note will never ship)' }]);
});

test('a new fragment for a released ref stays selected', (t) => {
  const plan = planFor(t, {
    fragments: { 'SQ-1': { title: 'Claim-token binding fixes concurrent dispatches', plugins: ['sidequest'], bump: 'patch' } },
    changelog: '# Changelog\n\n## v3.207.1 (2026-07-24)\n\n### sidequest 3.6.16 → 3.6.17\n\n#### Fixes\n- SQ-1 title (SQ-1)\n',
  });
  assert.deepEqual(plan.selected.map((fragment) => fragment.ref), ['SQ-1']);
  assert.deepEqual(plan.skipped, []);
});

test('a hotfix releases only the tickets it names', (t) => {
  const plan = planFor(t, {
    fragments: {
      'SQ-1': { plugins: ['sidequest'], bump: 'patch', commit: 'aaaaaaa' },
      'SQ-2': { plugins: ['workbench'], bump: 'minor', commit: 'bbbbbbb' },
      'SQ-3': { plugins: ['sidequest'], bump: 'major', commit: 'ccccccc' },
    },
    mode: 'hotfix',
    tickets: ['SQ-2'],
  });
  assert.deepEqual(plan.selected.map((fragment) => fragment.ref), ['SQ-2']);
  assert.deepEqual(plan.plugins.map((plugin) => `${plugin.name} ${plugin.to}`), ['workbench 0.64.0']);
  assert.deepEqual(plan.skipped.map((entry) => entry.ref).sort(), ['SQ-1', 'SQ-3']);
  assert.ok(plan.skipped.every((entry) => entry.reason === 'not named by --tickets'));
});

test('a hotfix refuses what it cannot honestly release', (t) => {
  const fragments = {
    'SQ-1': { title: 'Shipped', plugins: ['sidequest'], bump: 'patch', commit: 'aaaaaaa' },
    'SQ-2': { plugins: ['workbench'], bump: 'patch', hold: true, commit: 'bbbbbbb' },
  };
  assert.throws(() => planFor(t, { fragments, mode: 'hotfix', tickets: ['SQ-9'] }), /no fragment .*SQ-9\.md/);
  assert.throws(() => planFor(t, { fragments, mode: 'hotfix', tickets: [] }), /needs --tickets/);
  assert.throws(() => planFor(t, { fragments, mode: 'hotfix', tickets: ['SQ-2'] }), /marked "hold: true"/);
  assert.throws(
    () => planFor(t, {
      fragments,
      mode: 'hotfix',
      tickets: ['SQ-1'],
      changelog: '# Changelog\n\n## v1.0.0 (2026-07-24)\n\n#### Fixes\n- Shipped (SQ-1) [`aaaaaaa`](https://github.com/Eigenwise/eigenwise-toolshed/commit/aaaaaaa)\n',
    }),
    /already released this exact fragment/,
  );

  const forced = planFor(t, { fragments, mode: 'hotfix', tickets: ['SQ-2'], force: true });
  assert.deepEqual(forced.selected.map((fragment) => fragment.ref), ['SQ-2']);
});

test('only the changed plugins get their suites queued', (t) => {
  const plan = planFor(t, {
    fragments: { 'SQ-1': { plugins: ['sidequest', 'workbench'], bump: 'patch' } },
    suites: { sidequest: 'package', workbench: 'testdir', 'codex-gateway': 'package' },
  });
  assert.deepEqual(plan.suites, [
    { plugin: 'sidequest', cwd: 'plugins/sidequest', setup: 'npm ci', command: 'npm run test:full' },
    { plugin: 'workbench', cwd: 'plugins/workbench', setup: null, command: 'node --test --test-timeout=120000 "test/*.test.js"' },
  ]);
});

test('the commit message and the publish command come from the same plan', (t) => {
  const plan = planFor(t, {
    fragments: {
      'SQ-1': { plugins: ['sidequest'], bump: 'minor' },
      'SQ-2': { plugins: ['workbench'], bump: 'patch' },
    },
  });
  assert.equal(planCommitMessage(plan), 'release v3.208.0: sidequest 3.7.0, workbench 0.63.7 (SQ-1, SQ-2)');
  assert.equal(
    planPushCommand(plan, { commit: 'abc1234' }),
    'git push --atomic origin abc1234:refs/heads/main refs/tags/v3.208.0:refs/tags/v3.208.0 refs/tags/sidequest-v3.7.0:refs/tags/sidequest-v3.7.0 refs/tags/workbench-v0.63.7:refs/tags/workbench-v0.63.7',
  );
  assert.match(formatPlan(plan), /sidequest {2}3\.6\.17 -> 3\.7\.0 {2}\(minor\)/);
});

test('bad inputs are refused before anything is computed', (t) => {
  assert.throws(() => planFor(t, { mode: 'sideways' }), PlanError);
  assert.throws(() => planFor(t, { date: '25-07-2026' }), /must be YYYY-MM-DD/);
});
