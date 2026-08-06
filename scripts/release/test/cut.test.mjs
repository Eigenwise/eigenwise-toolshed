// Behaviour of a cut, against a real repository. What the engine writes, what it refuses, and what
// it leaves alone are all statements about a tree, so they are tested against one.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { assertParentCiPassed, cut, defaultSuiteRunner } from '../cut.mjs';
import { readValue } from '../lib/jsonedit.mjs';
import { makeGitRepo } from './realrepo.mjs';

const PLUGINS = { 'codex-gateway': '0.33.4', sidequest: '3.6.17', workbench: '0.63.6' };

function setup(t, options = {}) {
  const repo = makeGitRepo({ plugins: PLUGINS, ...options });
  t.after(repo.cleanup);
  const suites = [];
  return {
    ...repo,
    suites,
    runSuite: (suite) => {
      suites.push(suite.plugin);
      return { code: 0, command: suite.command };
    },
    read: (relative) => readFileSync(path.join(repo.root, relative), 'utf8'),
    exists: (relative) => existsSync(path.join(repo.root, relative)),
    version: (name) => readValue(readFileSync(path.join(repo.root, `plugins/${name}/.claude-plugin/plugin.json`), 'utf8'), ['version']),
    entryVersion: (name) => JSON.parse(readFileSync(path.join(repo.root, '.claude-plugin/marketplace.json'), 'utf8'))
      .plugins.find((entry) => entry.name === name).version,
    marketplaceVersion: () => JSON.parse(readFileSync(path.join(repo.root, '.claude-plugin/marketplace.json'), 'utf8')).version,
  };
}

test('a normal cut moves three version fields and nothing else', async (t) => {
  const context = setup(t);
  context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  context.writeFragment('SQ-2', { plugins: ['sidequest'], bump: 'minor' });
  context.writeFragment('SQ-3', { plugins: ['workbench'], bump: 'patch' });
  context.commit('integrate');

  const result = await cut({ repoRoot: context.root, runSuite: context.runSuite, log: () => {} });

  assert.equal(result.status, 'cut');
  assert.equal(context.version('sidequest'), '3.7.0', 'the highest level wins');
  assert.equal(context.entryVersion('sidequest'), '3.7.0');
  assert.equal(context.version('workbench'), '0.63.7');
  assert.equal(context.entryVersion('workbench'), '0.63.7');
  assert.equal(context.marketplaceVersion(), '3.208.0');
  assert.equal(context.version('codex-gateway'), '0.33.4', 'an untouched plugin never moves');
  assert.equal(context.entryVersion('codex-gateway'), '0.33.4');
  assert.deepEqual(context.suites, ['sidequest', 'workbench'], 'only the changed plugins are verified');
});

test('the release commit contains exactly what the cut generated', async (t) => {
  const context = setup(t);
  context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'minor' });
  context.writeFragment('SQ-2', { plugins: ['workbench'], bump: 'patch' });
  context.commit('integrate');

  const result = await cut({ repoRoot: context.root, skipTests: true, log: () => {} });

  assert.equal(result.message, 'release v3.208.0: sidequest 3.7.0, workbench 0.63.7 (SQ-1, SQ-2)');
  assert.deepEqual(context.git('show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).sort(), [
    '.claude-plugin/marketplace.json',
    '.release/unreleased/SQ-1.md',
    '.release/unreleased/SQ-2.md',
    'CHANGELOG.md',
    'plugins/sidequest/.claude-plugin/plugin.json',
    'plugins/sidequest/CHANGELOG.md',
    'plugins/workbench/.claude-plugin/plugin.json',
    'plugins/workbench/CHANGELOG.md',
  ]);
  assert.deepEqual(context.git('tag', '--list').split('\n').sort(), ['sidequest-v3.7.0', 'v3.208.0', 'workbench-v0.63.7']);
  for (const tag of result.plan.tags) {
    assert.equal(context.git('rev-list', '-n', '1', `refs/tags/${tag}`), result.commit);
  }
});

test('a cut generates the changelogs and consumes the fragments it used', async (t) => {
  const context = setup(t);
  context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'minor' });
  context.writeFragment('SQ-2', { plugins: ['workbench'], bump: 'patch', hold: true });
  context.commit('integrate');

  const result = await cut({ repoRoot: context.root, skipTests: true, log: () => {} });

  const changelog = context.read('CHANGELOG.md');
  assert.match(changelog, /^## v3\.208\.0 \(\d{4}-\d{2}-\d{2}\)$/m);
  assert.match(changelog, /### sidequest 3\.6\.17 → 3\.7\.0/);
  assert.doesNotMatch(changelog, /SQ-2/, 'a held fragment is not in the changelog');
  assert.match(context.read('plugins/sidequest/CHANGELOG.md'), /^## 3\.7\.0 \(\d{4}-\d{2}-\d{2}\)$/m);
  assert.equal(context.exists('plugins/workbench/CHANGELOG.md'), false, 'untouched plugins get no changelog');

  assert.equal(context.exists('.release/unreleased/SQ-1.md'), false, 'consumed');
  assert.equal(context.exists('.release/unreleased/SQ-2.md'), true, 'held fragments survive the cut');
  assert.deepEqual(result.consumed, ['.release/unreleased/SQ-1.md']);
});

test('rerunning the same cut releases nothing', async (t) => {
  const context = setup(t);
  context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  context.commit('integrate');

  await cut({ repoRoot: context.root, skipTests: true, log: () => {} });
  const before = context.read('CHANGELOG.md');

  const again = await cut({ repoRoot: context.root, skipTests: true, log: () => {} });
  assert.equal(again.status, 'nothing-to-release');
  assert.equal(context.version('sidequest'), '3.6.18', 'the second run does not double-bump');
  assert.equal(context.marketplaceVersion(), '3.208.0');
  assert.equal(context.read('CHANGELOG.md'), before);
});

test('a queued fragment for an already-released ref cannot ship twice', async (t) => {
  const context = setup(t, {
    changelog: '# Changelog\n\n## v3.207.0 (2026-07-24)\n\n### sidequest 3.6.16 → 3.6.17\n\n#### Fixes\n- Already out (SQ-1)\n',
  });
  context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  context.commit('integrate');

  const result = await cut({ repoRoot: context.root, skipTests: true, log: () => {} });
  assert.equal(result.status, 'nothing-to-release');
  assert.equal(context.version('sidequest'), '3.6.17');
});

test('a dry run writes nothing and moves no ref', async (t) => {
  const context = setup(t);
  context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'minor' });
  const integration = context.commit('integrate');

  const result = await cut({ repoRoot: context.root, dryRun: true, log: () => {} });

  assert.equal(result.status, 'dry-run');
  assert.equal(result.plan.plugins[0].to, '3.7.0');
  assert.equal(context.version('sidequest'), '3.6.17');
  assert.equal(context.exists('.release/unreleased/SQ-1.md'), true);
  assert.equal(context.exists('CHANGELOG.md'), false);
  assert.equal(context.git('rev-parse', 'HEAD'), integration, 'HEAD did not move');
  assert.equal(context.git('tag', '--list'), '', 'no tag was created');
});

test('.release/HOLD stops a normal window and --force overrides it', async (t) => {
  const context = setup(t);
  context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  context.write('.release/HOLD', 'waiting on the docs ticket\n');
  context.commit('integrate under a hold');

  const held = await cut({ repoRoot: context.root, skipTests: true, log: () => {} });
  assert.equal(held.status, 'held');
  assert.equal(held.reason, 'waiting on the docs ticket');
  assert.equal(context.version('sidequest'), '3.6.17');

  const forced = await cut({ repoRoot: context.root, skipTests: true, force: true, log: () => {} });
  assert.equal(forced.status, 'cut');
  assert.equal(context.version('sidequest'), '3.6.18');
});

test('an existing tag stops the cut instead of moving it', async (t) => {
  const context = setup(t);
  context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  const integration = context.commit('integrate');
  context.git('tag', 'v3.208.0', integration);

  await assert.rejects(
    () => cut({ repoRoot: context.root, skipTests: true, log: () => {} }),
    /these tags already exist.*v3\.208\.0/s,
  );
  assert.equal(context.version('sidequest'), '3.6.17');
  assert.equal(context.git('rev-list', '-n', '1', 'refs/tags/v3.208.0'), integration, 'the existing tag did not move');
});

test('a plugin whose manifest and marketplace entry disagree blocks the cut', async (t) => {
  const context = setup(t);
  const manifestPath = path.join(context.root, 'plugins/sidequest/.claude-plugin/plugin.json');
  writeFileSync(manifestPath, readFileSync(manifestPath, 'utf8').replace('3.6.17', '3.6.12'));
  context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  context.commit('integrate with drifted versions');

  await assert.rejects(
    () => cut({ repoRoot: context.root, skipTests: true, log: () => {} }),
    /version mismatch.*marketplace\.json says 3\.6\.17.*says 3\.6\.12/s,
  );
});

test('a hotfix releases only its tickets and leaves the rest unreleased', async (t) => {
  const context = setup(t);
  context.onBranch('dev');
  context.write('plugins/workbench/urgent.js', '// urgent\n');
  const fixSha = context.commit('the urgent fix');
  context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'minor', commit: fixSha });
  context.writeFragment('SQ-2', { plugins: ['workbench'], bump: 'minor', commit: fixSha });
  const devSha = context.commit('note both tickets');
  context.onBranch('main');

  const result = await cut({
    repoRoot: context.root,
    mode: 'hotfix',
    tickets: ['SQ-2'],
    sha: devSha,
    skipTests: true,
    log: () => {},
  });

  assert.equal(result.status, 'cut');
  assert.equal(context.version('workbench'), '0.64.0');
  assert.equal(context.version('sidequest'), '3.6.17', 'the unreleased ticket stays unreleased');
  assert.equal(context.marketplaceVersion(), '3.207.1', 'a hotfix patches the counter');
  assert.deepEqual(result.plan.tags, ['v3.207.1', 'workbench-v0.64.0']);
  assert.match(context.read('CHANGELOG.md'), /Hotfix release cut from `main`/);
  assert.equal(context.exists('plugins/workbench/urgent.js'), true, 'the fix was cherry-picked');
});

test('a hotfix skips a cherry-pick that the publish branch already contains', async (t) => {
  const context = setup(t);
  context.write('plugins/workbench/already.js', '// already on main\n');
  const fixSha = context.commit('a fix that is already on main');
  context.onBranch('dev');
  context.git('merge', '-q', 'main');
  context.writeFragment('SQ-2', { plugins: ['workbench'], bump: 'patch', commit: fixSha });
  const devSha = context.commit('note it');
  context.onBranch('main');

  const result = await cut({ repoRoot: context.root, mode: 'hotfix', tickets: ['SQ-2'], sha: devSha, skipTests: true, log: () => {} });

  assert.equal(result.status, 'cut');
  assert.equal(context.version('workbench'), '0.63.7');
  assert.equal(
    context.git('log', '--format=%s', '-n', '2').split('\n')[1],
    'a fix that is already on main',
    'the release commit sits straight on the fix, with no duplicate cherry-pick',
  );
});

test('the cut refuses a dirty tree and the wrong branch', async (t) => {
  const dirty = setup(t);
  dirty.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  dirty.commit('integrate');
  writeFileSync(path.join(dirty.root, 'plugins/sidequest/index.js'), '// edited\n');
  await assert.rejects(() => cut({ repoRoot: dirty.root, skipTests: true, log: () => {} }), /uncommitted changes/);

  const wrongBranch = setup(t);
  wrongBranch.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  wrongBranch.commit('integrate');
  wrongBranch.onBranch('dev');
  wrongBranch.git('merge', '-q', 'main');
  await assert.rejects(() => cut({ repoRoot: wrongBranch.root, skipTests: true, log: () => {} }), /cutting from "dev"/);
});

test('a failing suite leaves the release local and says so', async (t) => {
  const context = setup(t);
  context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  context.commit('integrate');
  const before = context.remoteRefs();

  await assert.rejects(
    () => cut({
      repoRoot: context.root,
      push: true,
      log: () => {},
      runSuite: (suite) => ({ code: 1, command: suite.command }),
    }),
    /release suites failed, nothing was published/,
  );

  assert.deepEqual(context.remoteRefs(), before);
});

test('a failed Test workflow on the remote parent blocks a local cut', async (t) => {
  const context = setup(t);
  context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  const localParent = context.commit('integrate');
  const remoteParent = context.originGit('rev-parse', 'main');
  const before = context.remoteRefs();
  let checkedCommit = null;
  const failedTestRun = () => ({
    status: 0,
    stdout: JSON.stringify([{ headSha: remoteParent, conclusion: 'failure' }]),
    stderr: '',
  });

  assert.throws(
    () => assertParentCiPassed(context.root, remoteParent, failedTestRun),
    /Test workflow for .* concluded failure; refusing to publish/,
  );
  await assert.rejects(
    () => cut({
      repoRoot: context.root,
      skipTests: true,
      log: () => {},
      assertParentCiPassed: (repoRoot, commit) => {
        checkedCommit = commit;
        return assertParentCiPassed(repoRoot, commit, failedTestRun);
      },
    }),
    /Test workflow for .* concluded failure; refusing to publish/,
  );
  assert.equal(checkedCommit, remoteParent);
  assert.notEqual(checkedCommit, localParent);
  assert.deepEqual(context.remoteRefs(), before);
});

test('a local cut prints the passing remote CI verdict with its push command', async (t) => {
  const context = setup(t);
  context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  context.commit('integrate');
  const remoteParent = context.originGit('rev-parse', 'main');
  const logs = [];

  const result = await cut({
    repoRoot: context.root,
    skipTests: true,
    log: (message) => logs.push(message),
    assertParentCiPassed: (repoRoot, commit) => {
      assert.equal(commit, remoteParent);
      return { commit, conclusion: 'success' };
    },
  });

  assert.deepEqual(result.ci, { status: 'passed', commit: remoteParent, conclusion: 'success' });
  assert.ok(logs.includes(`Test CI on origin/main (${remoteParent}) passed.`));
  assert.ok(logs.includes(`  ${result.pushCommand}`));
});

test('a CI override records its reason for a local cut', async (t) => {
  const context = setup(t);
  context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  context.commit('integrate');
  const remoteParent = context.originGit('rev-parse', 'main');
  const logs = [];

  const result = await cut({
    repoRoot: context.root,
    skipTests: true,
    ciOverrideReason: 'SQ-1349 repairs the failed Test workflow',
    log: (message) => logs.push(message),
    assertParentCiPassed: (repoRoot, commit) => assertParentCiPassed(repoRoot, commit, () => ({
      status: 0,
      stdout: JSON.stringify([{ headSha: remoteParent, conclusion: 'failure' }]),
      stderr: '',
    })),
  });

  assert.deepEqual(result.ci, {
    status: 'overridden',
    commit: remoteParent,
    reason: 'SQ-1349 repairs the failed Test workflow',
    error: `Test workflow for ${remoteParent} concluded failure; refusing to publish. Retry with --ci-override "<reason>" only when the release fixes that CI failure.`,
  });
  assert.ok(logs.includes(`Test CI on origin/main (${remoteParent}) was overridden: SQ-1349 repairs the failed Test workflow`));
});

test('a missing Test workflow run offers the optional container check', (t) => {
  const context = setup(t);
  const parent = context.originGit('rev-parse', 'main');

  assert.throws(
    () => assertParentCiPassed(context.root, parent, () => ({ status: 0, stdout: '[]', stderr: '' })),
    /no completed Test workflow run found.*git archive .*\| docker run -i --rm node:22.*git init -q/s,
  );
});

test('a failing default suite writes its output and names the log', async (t) => {
  const context = setup(t);
  context.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  context.commit('integrate');
  const runner = defaultSuiteRunner(context.root, { log: () => {}, tag: 'v-test' });
  let failure;

  await assert.rejects(
    () => cut({
      repoRoot: context.root,
      log: () => {},
      runSuite: (suite) => runner({
        ...suite,
        cwd: 'plugins/sidequest',
        setup: null,
        command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('suite stdout'); process.stderr.write('suite stderr'); process.exit(1)"`,
      }),
    }),
    (error) => {
      failure = error;
      return /release suites failed, nothing was published/.test(error.message);
    },
  );

  const match = failure.message.match(/log: (\.release.*\.log)/);
  assert.ok(match, `the failure names the suite log: ${failure.message}`);
  assert.equal(context.read(match[1]), 'suite stdoutsuite stderr');
});
