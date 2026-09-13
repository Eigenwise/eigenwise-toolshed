// The split publish boundary: preparation may never touch the protected publish branch, and
// finalization may only tag the exact commit the promotion PR merged. Every case runs against a real
// repository with a real local `origin`, because these are claims about refs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { spawnSync } from 'node:child_process';

import { cut } from '../cut.mjs';
import { finalize, main as finalizeCli } from '../finalize.mjs';
import { publishedEntryMatches, runGuard } from '../guard.mjs';
import { derivePublication, PublicationError } from '../lib/publication.mjs';
import { createGit } from '../lib/git.mjs';
import { makeGitRepo } from './realrepo.mjs';

const PLUGINS = { sidequest: '3.6.17', workbench: '0.63.6' };
const TAG = 'v3.208.0';
const RELEASE_BRANCH = `release/${TAG}`;
const PLUGIN_TAGS = ['sidequest-v3.7.0', 'workbench-v0.63.7'];

const publishLock = () => ({ acquire: async () => ({ ok: true }), release: async () => ({ ok: true }) });
const ciPassed = () => ({ conclusion: 'success' });

function setup(t) {
  const repo = makeGitRepo({ plugins: PLUGINS });
  t.after(repo.cleanup);
  repo.git('checkout', '-q', '-b', 'develop');
  repo.git('push', '-q', 'origin', 'develop');
  repo.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'minor' });
  repo.writeFragment('SQ-2', { plugins: ['workbench'], bump: 'patch' });
  repo.commit('integrate');
  repo.git('push', '-q', 'origin', 'develop');
  return repo;
}

function prepare(repo, options = {}) {
  return cut({ repoRoot: repo.root, prepare: true, skipTests: true, publishLock: publishLock(), log: () => {}, ...options });
}

/** What merging the promotion PR does, in a local origin with no protection to get in the way. */
function mergePromotionPr(repo) {
  repo.git('checkout', '-q', 'main');
  repo.git('merge', '-q', '--no-ff', '-m', `Merge pull request: release ${TAG}`, RELEASE_BRANCH);
  repo.git('push', '-q', 'origin', 'main');
  return repo.git('rev-parse', 'HEAD');
}

/**
 * The same merge, but the local checkout is left exactly where the printed sequence leaves it: on the
 * release branch. Nothing in `gh pr merge` + `finalize.mjs --push` checks main out.
 */
function mergePromotionPrOnTheForge(repo) {
  const checkedOut = repo.git('rev-parse', '--abbrev-ref', 'HEAD');
  const merged = mergePromotionPr(repo);
  repo.git('checkout', '-q', checkedOut);
  return merged;
}

function tagsOn(repo) {
  return Object.keys(repo.remoteRefs()).filter((ref) => ref.startsWith('refs/tags/')).sort();
}

const REPOSITORY = 'Eigenwise/eigenwise-toolshed';

function syncBackPullRequest(repo, { baseRepo = REPOSITORY, headRepo = REPOSITORY, baseRef = 'develop' } = {}) {
  return {
    baseRepo,
    headRepo,
    baseRef,
    headSha: repo.git('rev-parse', 'HEAD'),
  };
}

function guardOn(repo, options) {
  return runGuard(repo.root, {
    publishRef: 'origin/main',
    git: createGit({ cwd: repo.root }),
    changed: repo.git('diff', '--name-only', `${options.base}..HEAD`).split('\n').filter(Boolean),
    ...options,
  });
}

/** The `main -> develop` sync PR exactly as finalize.mjs prints it. */
function buildSyncBackBranch(repo, tag) {
  repo.git('fetch', '-q', 'origin', 'main', 'develop');
  repo.git('switch', '-q', '-c', `sync/main-to-develop-${tag}`, 'origin/develop');
  repo.git('merge', '-q', '--no-ff', '-m', `sync ${tag} into develop`, 'origin/main');
  return repo.git('rev-parse', 'HEAD');
}

/** A published release with its sync-back branch checked out, which is what the waiver is about. */
async function releasedWithSyncBranch(t) {
  const repo = setup(t);
  await prepare(repo, { push: true });
  mergePromotionPrOnTheForge(repo);
  await finalize({
    repoRoot: repo.root, push: true, publishLock: publishLock(), assertParentCiPassed: ciPassed, log: () => {},
  });
  buildSyncBackBranch(repo, TAG);
  return repo;
}

const SIDEQUEST_MANIFEST = 'plugins/sidequest/.claude-plugin/plugin.json';

function parentCount(repo) {
  return repo.git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length - 1;
}

test('a prepared release leaves main and develop exactly where they were', async (t) => {
  const repo = setup(t);
  const before = repo.remoteRefs();
  const developBefore = repo.git('rev-parse', 'develop');

  const result = await prepare(repo, { push: true });

  assert.equal(result.status, 'prepared');
  assert.equal(result.releaseBranch, RELEASE_BRANCH);
  const after = repo.remoteRefs();
  assert.equal(after['refs/heads/main'], before['refs/heads/main'], 'main never moves during preparation');
  assert.equal(after['refs/heads/develop'], before['refs/heads/develop'], 'develop never carries the release commit');
  assert.equal(after[`refs/heads/${RELEASE_BRANCH}`], result.commit);
  assert.deepEqual(tagsOn(repo), [], 'preparation creates no tag, local or remote');
  assert.equal(repo.git('tag', '--list'), '');
  assert.equal(repo.git('rev-parse', 'develop'), developBefore);
  assert.equal(repo.git('rev-parse', '--abbrev-ref', 'HEAD'), RELEASE_BRANCH);
  assert.match(result.pushCommands.join('\n'), /gh pr create --base main --head release\/v3\.208\.0/);
});

test('a failing suite rolls the prepared branch away and leaves a clean tree on develop', async (t) => {
  const repo = setup(t);
  const before = repo.remoteRefs();
  const developBefore = repo.git('rev-parse', 'develop');

  await assert.rejects(
    () => prepare(repo, { skipTests: false, runSuite: (suite) => ({ code: suite.plugin === 'workbench' ? 1 : 0, command: suite.command }) }),
    /release suites failed/,
  );

  assert.deepEqual(repo.remoteRefs(), before);
  assert.equal(repo.git('rev-parse', 'develop'), developBefore);
  assert.equal(repo.git('rev-parse', '--abbrev-ref', 'HEAD'), 'develop');
  assert.equal(repo.git('status', '--porcelain'), '', 'the working tree is clean again');
  assert.equal(repo.git('branch', '--list', RELEASE_BRANCH), '');
});

test('finalize refuses a commit that is not the merged publish-branch head', async (t) => {
  const repo = setup(t);
  const prepared = await prepare(repo, { push: true });

  await assert.rejects(
    () => finalize({
      repoRoot: repo.root,
      commit: prepared.commit,
      push: true,
      publishLock: publishLock(),
      assertParentCiPassed: ciPassed,
      log: () => {},
    }),
    /origin\/main is at [0-9a-f]{40}, not [0-9a-f]{40}; a release is tagged only at the exact merged main commit/,
  );

  assert.deepEqual(tagsOn(repo), [], 'an unmerged release publishes no tag');
});

test('finalize refuses to publish when Test failed on the merged commit', async (t) => {
  const repo = setup(t);
  await prepare(repo, { push: true });
  const merged = mergePromotionPr(repo);

  await assert.rejects(
    () => finalize({
      repoRoot: repo.root,
      push: true,
      publishLock: publishLock(),
      assertParentCiPassed: (root, commit) => {
        assert.equal(commit, merged, 'CI is checked on the merged commit, not on the release branch');
        throw new Error(`Test workflow for ${commit} concluded failure; refusing to publish.`);
      },
      log: () => {},
    }),
    /concluded failure/,
  );

  assert.deepEqual(tagsOn(repo), []);
  assert.equal(repo.git('tag', '--list'), '', 'not even a local tag survives the refusal');
});

test('finalize tags the exact merged commit and pushes nothing but tags', async (t) => {
  const repo = setup(t);
  await prepare(repo, { push: true });
  const merged = mergePromotionPr(repo);
  const before = repo.remoteRefs();
  const pushes = [];
  const git = createGit({
    cwd: repo.root,
    onCommand: (entry) => {
      if (entry.args[0] === 'push') pushes.push(entry.args.join(' '));
    },
  });

  const result = await finalize({
    repoRoot: repo.root,
    git,
    push: true,
    publishLock: publishLock(),
    assertParentCiPassed: ciPassed,
    log: () => {},
  });

  assert.equal(result.status, 'published');
  assert.equal(result.commit, merged);
  assert.deepEqual(result.publication.tags, [TAG, ...PLUGIN_TAGS]);
  const after = repo.remoteRefs();
  assert.equal(after['refs/heads/main'], before['refs/heads/main'], 'finalize never moves a branch');
  for (const tag of [TAG, ...PLUGIN_TAGS]) {
    assert.ok(after[`refs/tags/${tag}`], `${tag} reached origin`);
    assert.equal(repo.git('rev-list', '-n', '1', `refs/tags/${tag}`), merged, `${tag} points at the merged commit`);
  }
  assert.equal(pushes.length, 2, 'the marketplace tag publishes separately from the plugin tags');
  for (const push of pushes) assert.doesNotMatch(push, /refs\/heads\//);
  assert.match(result.syncCommands.join('\n'), /gh pr create --base develop/);
});

test('finalizing twice publishes nothing new and bumps no version', async (t) => {
  const repo = setup(t);
  await prepare(repo, { push: true });
  const merged = mergePromotionPr(repo);
  const options = {
    repoRoot: repo.root,
    push: true,
    publishLock: publishLock(),
    assertParentCiPassed: ciPassed,
    log: () => {},
  };

  await finalize(options);
  const after = repo.remoteRefs();
  const marketplace = repo.git('show', `${merged}:.claude-plugin/marketplace.json`);

  const second = await finalize(options);

  assert.equal(second.status, 'already-published');
  assert.equal(second.pushed, false);
  assert.deepEqual(second.missing, []);
  assert.deepEqual(repo.remoteRefs(), after, 'not one ref moved on the second run');
  assert.equal(repo.git('rev-parse', 'origin/main'), merged, 'no second release commit exists');
  assert.equal(repo.git('show', `${merged}:.claude-plugin/marketplace.json`), marketplace);
});

test('finalize refuses to move a tag that already points somewhere else', async (t) => {
  const repo = setup(t);
  await prepare(repo, { push: true });
  const merged = mergePromotionPr(repo);
  const elsewhere = repo.git('rev-parse', `${merged}^1`);
  repo.git('tag', '-a', TAG, '-m', 'an earlier publication', elsewhere);
  repo.git('push', '-q', 'origin', `refs/tags/${TAG}`);
  repo.git('tag', '-d', TAG);

  await assert.rejects(
    () => finalize({
      repoRoot: repo.root,
      push: true,
      publishLock: publishLock(),
      assertParentCiPassed: ciPassed,
      log: () => {},
    }),
    /already exist on origin pointing somewhere other than/,
  );

  assert.equal(createGit({ cwd: repo.root }).remoteTagTargets('origin').get(TAG), elsewhere);
});

test('a commit that moved no version publishes no release', () => {
  const manifest = (version, plugins) => ({
    version,
    plugins: new Map(Object.entries(plugins).map(([name, pluginVersion]) => [name, { name, version: pluginVersion }])),
  });

  assert.throws(
    () => derivePublication({ before: manifest('3.207.0', PLUGINS), after: manifest('3.207.0', PLUGINS) }),
    PublicationError,
  );

  const publication = derivePublication({
    before: manifest('3.207.0', PLUGINS),
    after: manifest('3.208.0', { sidequest: '3.7.0', workbench: '0.63.6' }),
  });
  assert.deepEqual(publication.tags, ['v3.208.0', 'sidequest-v3.7.0']);
  assert.equal(publication.tagMessage, 'release v3.208.0: sidequest 3.7.0');
});

test('finalize tags the merged main commit from the checkout the printed sequence leaves behind', async (t) => {
  const repo = setup(t);
  const prepared = await prepare(repo, { push: true });
  const merged = mergePromotionPrOnTheForge(repo);
  const checkedOut = repo.git('rev-parse', 'HEAD');

  // The printed happy path is exactly: push the branch, open the PR, merge it, finalize.
  assert.match(prepared.pushCommands.join('\n'), /gh pr merge --merge[\s\S]*finalize\.mjs --push/);
  assert.notEqual(checkedOut, merged, 'the release branch is still checked out, as the cut left it');

  const result = await finalize({
    repoRoot: repo.root,
    push: true,
    publishLock: publishLock(),
    assertParentCiPassed: ciPassed,
    log: () => {},
  });

  assert.equal(result.commit, merged);
  for (const tag of [TAG, ...PLUGIN_TAGS]) {
    assert.equal(repo.git('rev-list', '-n', '1', `refs/tags/${tag}`), merged, `${tag} points at the merged main commit`);
  }
  assert.equal(repo.git('rev-parse', 'HEAD'), checkedOut, 'finalize never moved the checkout');
});

test('publishing main straight from a cut is off unless it is asked for by name', async (t) => {
  const repo = setup(t);
  const before = repo.remoteRefs();

  await assert.rejects(
    () => cut({ repoRoot: repo.root, push: true, skipTests: true, branchCheck: false, publishLock: publishLock(), log: () => {} }),
    /publishing main directly is off by default/,
  );

  assert.deepEqual(repo.remoteRefs(), before, 'the refusal happens before anything is built');
  assert.equal(repo.git('tag', '--list'), '');
});

test('a tag is never created without an explicit target', (t) => {
  const repo = setup(t);
  assert.throws(
    () => createGit({ cwd: repo.root }).tag('v9.9.9', 'no target'),
    /refusing to create tag v9\.9\.9 without an explicit target commit/,
  );
  assert.equal(repo.git('tag', '--list'), '');
});

test('finalize has no override for a failed Test run on the merged commit', async (t) => {
  const repo = setup(t);
  await prepare(repo, { push: true });
  mergePromotionPrOnTheForge(repo);

  await assert.rejects(
    () => finalize({
      repoRoot: repo.root,
      push: true,
      publishLock: publishLock(),
      // The removed escape hatches, offered every way a caller could still reach for them.
      ciOverrideReason: 'the release fixes that failure',
      previous: 'origin/main',
      assertParentCiPassed: () => { throw new Error('Test workflow concluded failure; refusing to publish.'); },
      log: () => {},
    }),
    /concluded failure/,
  );
  await assert.rejects(() => finalizeCli(['--ci-override', 'why']), /ci-override/);
  await assert.rejects(() => finalizeCli(['--previous', 'HEAD~5']), /previous/);

  assert.deepEqual(tagsOn(repo), []);
  assert.equal(repo.git('tag', '--list'), '');
});

test('finalize compares against the first parent only, so an ordinary main commit publishes nothing', async (t) => {
  const repo = setup(t);
  await prepare(repo, { push: true });
  const releaseMerge = mergePromotionPrOnTheForge(repo);
  await finalize({
    repoRoot: repo.root, push: true, publishLock: publishLock(), assertParentCiPassed: ciPassed, log: () => {},
  });
  const published = repo.remoteRefs();

  repo.git('checkout', '-q', 'main');
  repo.write('README.md', '# ordinary work\n');
  repo.commit('docs: ordinary commit after the release');
  repo.git('push', '-q', 'origin', 'main');

  await assert.rejects(
    () => finalize({
      repoRoot: repo.root, push: true, publishLock: publishLock(), assertParentCiPassed: ciPassed, log: () => {},
    }),
    PublicationError,
  );

  assert.deepEqual(repo.remoteRefs(), { ...published, 'refs/heads/main': repo.git('rev-parse', 'main') });
  assert.notEqual(repo.git('rev-parse', 'main'), releaseMerge);
});

test('main advancing while Test is checked refuses the publication and creates no tag', async (t) => {
  const repo = setup(t);
  await prepare(repo, { push: true });
  const merged = mergePromotionPrOnTheForge(repo);
  const checkedOut = repo.git('rev-parse', 'HEAD');

  // Another writer lands on main between the validation and the tag push.
  const advanceMain = () => {
    repo.git('checkout', '-q', 'main');
    repo.write('README.md', '# someone else was here\n');
    repo.commit('docs: unrelated work');
    repo.git('push', '-q', 'origin', 'main');
    repo.git('checkout', '-q', checkedOut);
    return ciPassed();
  };

  await assert.rejects(
    () => finalize({
      repoRoot: repo.root,
      push: true,
      publishLock: publishLock(),
      assertParentCiPassed: advanceMain,
      log: () => {},
    }),
    /moved to [0-9a-f]{40} while this release was being validated/,
  );

  assert.deepEqual(tagsOn(repo), [], 'a moved publish branch publishes no tag');
  assert.equal(repo.git('tag', '--list'), '');
  assert.notEqual(repo.git('rev-parse', 'origin/main'), merged);
});

test('a release promotion into main passes the guard and an ordinary change into main does not', async (t) => {
  const repo = setup(t);
  const prepared = await prepare(repo, { push: true });

  const promotion = guardOn(repo, { mode: 'main', base: 'origin/main' });
  assert.deepEqual(promotion.failures, []);
  assert.equal(prepared.commit, repo.git('rev-parse', 'HEAD'));

  mergePromotionPrOnTheForge(repo);
  repo.git('checkout', '-q', 'main');
  repo.git('fetch', '-q', 'origin', 'main');
  repo.git('merge', '-q', '--ff-only', 'origin/main');
  const publishedHead = repo.git('rev-parse', 'HEAD');
  repo.write('docs/whatever.md', '# just docs\n');
  repo.commit('docs: nothing to release');

  const docsOnly = guardOn(repo, { mode: 'main', base: publishedHead });
  assert.equal(docsOnly.ok, false);
  assert.match(docsOnly.failures.join('\n'), /marketplace\.json is 3\.208\.0 on both sides of this change, so it publishes no release/);
});

test('the verified sync-back passes the guard that a branch name alone must not satisfy', async (t) => {
  const repo = await releasedWithSyncBranch(t);

  const verified = guardOn(repo, { base: 'origin/develop', pullRequest: syncBackPullRequest(repo) });
  assert.deepEqual(verified.failures, [], 'the release cut already consumed the fragments its manifests moved for');
  assert.equal(verified.syncBack?.ok, true);

  // Exactly the state that made the sync PR unmergeable: no verified provenance, no waiver.
  const unverified = guardOn(repo, { base: 'origin/develop' });
  assert.match(unverified.failures.join('\n'), /"sidequest" changed with no fragment naming it/);
  assert.match(unverified.failures.join('\n'), /"workbench" changed with no fragment naming it/);

  const fromAFork = guardOn(repo, {
    base: 'origin/develop',
    pullRequest: syncBackPullRequest(repo, { headRepo: 'someone/fork' }),
  });
  assert.equal(fromAFork.syncBack?.ok, false);
  assert.match(fromAFork.failures.join('\n'), /changed with no fragment naming it/);
  assert.match(fromAFork.notes.join('\n'), /head repository \(someone\/fork\) is not its base repository/);

  const wrongBase = guardOn(repo, {
    base: 'origin/develop',
    pullRequest: { ...syncBackPullRequest(repo), baseRef: 'main' },
  });
  assert.equal(wrongBase.syncBack?.ok, false);
});

test('develop work riding the sync gets no release exemption from it', async (t) => {
  const repo = await releasedWithSyncBranch(t);
  repo.write('plugins/sidequest/index.js', '// smuggled past the fragment rule\n');
  repo.commit('feat: an unreleased plugin change riding the sync');

  const result = guardOn(repo, { base: 'origin/develop', pullRequest: syncBackPullRequest(repo) });

  assert.equal(result.syncBack?.ok, true, 'the release really is arriving; the waiver is decided per path');
  assert.equal(result.ok, false);
  assert.match(result.failures.join('\n'), /"sidequest" changed with no fragment naming it/);
});

test('a merge commit that rewrites a released manifest gets no waiver for it', async (t) => {
  const repo = await releasedWithSyncBranch(t);
  const published = JSON.parse(repo.git('show', `origin/main:${SIDEQUEST_MANIFEST}`));
  repo.write(SIDEQUEST_MANIFEST, `${JSON.stringify({ ...published, description: 'forged in the merge' }, null, 2)}\n`);
  repo.git('add', '--', SIDEQUEST_MANIFEST);
  repo.git('commit', '-q', '--amend', '--no-edit');

  const result = guardOn(repo, { base: 'origin/develop', pullRequest: syncBackPullRequest(repo) });

  assert.equal(parentCount(repo), 2, 'the edit rides the merge commit itself, where no non-merge commit can see it');
  assert.equal(result.syncBack?.ok, true, 'it is shaped like a sync-back, which is exactly why shape cannot be the proof');
  assert.equal(result.ok, false);
  assert.match(result.notes.join('\n'), new RegExp(`${SIDEQUEST_MANIFEST} keeps its fragment requirement: its content here is`));
  assert.match(result.notes.join('\n'), /rebuild the sync as a plain merge of the publish branch or release that edit with its own fragment/);
  assert.match(result.failures.join('\n'), /"sidequest" changed with no fragment naming it/);
});

test('a merge commit that only changes a released manifest mode gets no waiver for it', async (t) => {
  const repo = await releasedWithSyncBranch(t);
  repo.git('update-index', '--chmod=+x', '--', SIDEQUEST_MANIFEST);
  repo.git('commit', '-q', '--amend', '--no-edit');

  const result = guardOn(repo, { base: 'origin/develop', pullRequest: syncBackPullRequest(repo) });

  assert.equal(
    repo.git('rev-parse', `HEAD:${SIDEQUEST_MANIFEST}`),
    repo.git('rev-parse', `origin/main:${SIDEQUEST_MANIFEST}`),
    'the bytes are identical, so only the mode can fail this',
  );
  assert.equal(result.ok, false);
  assert.match(result.notes.join('\n'), /its mode here is 100755 but [0-9a-f]{40} published 100644/);
  assert.match(result.failures.join('\n'), /"sidequest" changed with no fragment naming it/);
});

test('the entry proof refuses anything it cannot read as the same ordinary file', async (t) => {
  const repo = await releasedWithSyncBranch(t);
  const git = createGit({ cwd: repo.root });
  const published = repo.git('rev-parse', 'origin/main');
  const resulting = repo.git('rev-parse', 'HEAD');
  const beforeRelease = repo.git('rev-parse', 'origin/develop');

  assert.equal(publishedEntryMatches(git, published, resulting, SIDEQUEST_MANIFEST).ok, true);
  // The cut consumed this fragment and the sync carries that deletion: absent on both sides agrees.
  assert.equal(publishedEntryMatches(git, published, resulting, '.release/unreleased/SQ-1.md').ok, true);

  const deleted = publishedEntryMatches(git, published, beforeRelease, 'CHANGELOG.md');
  assert.equal(deleted.ok, false);
  assert.match(deleted.reason, /deletes it while [0-9a-f]{40} still has it/);

  const invented = publishedEntryMatches(git, beforeRelease, published, 'CHANGELOG.md');
  assert.equal(invented.ok, false);
  assert.match(invented.reason, /does not have it, so no release published it/);

  const notAFile = publishedEntryMatches(git, published, resulting, 'plugins/sidequest/.claude-plugin');
  assert.equal(notAFile.ok, false);
  assert.match(notAFile.reason, /it is a tree entry, which the release waiver does not cover/);

  const unreadable = publishedEntryMatches(git, '0'.repeat(40), resulting, SIDEQUEST_MANIFEST);
  assert.equal(unreadable.ok, false);
  assert.match(unreadable.reason, /could not be read at 0{40}/);
});

// Protection requires named checks, so the trigger list and the aggregate job are part of the
// release contract rather than incidental workflow detail.
test('CI covers develop pushes and every pull request behind one aggregate job', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/test.yml', import.meta.url), 'utf8');

  assert.match(workflow, /^ {4}branches: \[main, develop\]$/m);
  assert.match(workflow, /^ {2}pull_request:$/m);
  assert.match(workflow, /^ {2}test-complete:$/m);
  assert.match(workflow, /needs: \[release-engine, plugin-matrix, affected-plugin\]/);
});

test('the test-complete aggregate fails on every result that is not success', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/test.yml', import.meta.url), 'utf8');
  const script = /node -e '([\s\S]*?)\n *'/.exec(workflow)?.[1];
  assert.ok(script, 'the aggregate job runs an inline node script');

  const aggregate = (results) => spawnSync(process.execPath, ['-e', script], {
    env: { ...process.env, RESULTS: JSON.stringify(results) },
    encoding: 'utf8',
  }).status;

  assert.equal(aggregate({ a: { result: 'success' }, b: { result: 'success' } }), 0);
  for (const result of ['failure', 'cancelled', 'skipped', 'neutral', '']) {
    assert.equal(aggregate({ a: { result: 'success' }, b: { result } }), 1, `${result || 'an empty result'} fails the aggregate`);
  }
});
