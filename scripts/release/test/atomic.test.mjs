// The publish boundary: what reaches a remote, when, and what a failure leaves behind. Every case
// runs against a real repository with a real local `origin`, because these are claims about git.
import assert from 'node:assert/strict';
import test from 'node:test';

import { cut } from '../cut.mjs';
import { createGit, mutatesRemote, spawnRunner } from '../lib/git.mjs';
import { makeGitRepo } from './realrepo.mjs';

const PLUGINS = { sidequest: '3.6.17', workbench: '0.63.6' };

function setup(t) {
  const repo = makeGitRepo({ plugins: PLUGINS });
  t.after(repo.cleanup);
  repo.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'minor' });
  repo.writeFragment('SQ-2', { plugins: ['workbench'], bump: 'patch' });
  repo.commit('integrate');
  return repo;
}

test('push is the only verb that can change a remote', () => {
  for (const args of [
    ['merge', '--ff-only', 'x'],
    ['commit', '-m', 'x'],
    ['tag', '-a', 'v1'],
    ['ls-remote', '--tags', 'origin'],
    ['rev-parse', 'HEAD'],
    ['diff', '--cached', '--name-only'],
    ['rev-list', '-n', '1', 'refs/tags/v1'],
  ]) {
    assert.equal(mutatesRemote(args), false, args.join(' '));
  }
  assert.equal(mutatesRemote(['push', '--atomic', 'origin', 'HEAD:main']), true);
});

test('every remote-changing command happens after the whole release is built', async (t) => {
  const repo = setup(t);
  const calls = [];
  const git = createGit({ cwd: repo.root, onCommand: (entry) => calls.push(entry.args.join(' ')) });

  const result = await cut({ repoRoot: repo.root, git, push: true, skipTests: true, log: () => {} });

  const mutations = calls.filter((call) => call.startsWith('push'));
  assert.equal(mutations.length, 1, 'exactly one command can touch a remote');
  assert.equal(calls.at(-1), mutations[0], 'the atomic push is the last thing that runs');

  const pushIndex = calls.indexOf(mutations[0]);
  for (const verb of ['commit -m', 'tag -a v3.208.0', 'add --']) {
    const index = calls.findIndex((call) => call.startsWith(verb));
    assert.ok(index !== -1 && index < pushIndex, `${verb} must run before the push`);
  }
  assert.equal(repo.remoteRefs()['refs/heads/main'], result.commit);
});

test('one push carries the branch and every tag by explicit sha, so no ref can land alone', async (t) => {
  const repo = setup(t);
  const logged = [];

  const result = await cut({ repoRoot: repo.root, push: true, skipTests: true, log: (line) => logged.push(line) });

  assert.equal(result.refspecs[0], `${result.commit}:refs/heads/main`, 'the branch moves to the verified commit, not to whatever HEAD is');
  assert.equal(result.refspecs.length, result.plan.tags.length + 1);
  for (const tag of result.plan.tags) assert.ok(result.refspecs.includes(`refs/tags/${tag}:refs/tags/${tag}`));

  const remote = repo.remoteRefs();
  assert.equal(remote['refs/heads/main'], result.commit);
  for (const tag of result.plan.tags) assert.ok(remote[`refs/tags/${tag}`], `${tag} rode the same push`);
  assert.doesNotMatch(logged.join('\n'), /restore the invariant/);
});

test('a rejected ref rejects the whole push, so the remote never half-publishes', async (t) => {
  const repo = setup(t);
  const integration = repo.git('rev-parse', 'HEAD');
  repo.git('tag', 'v3.208.0', integration);
  repo.git('push', '-q', 'origin', 'refs/tags/v3.208.0');
  repo.git('tag', '-d', 'v3.208.0');
  const before = repo.remoteRefs();

  await assert.rejects(
    () => cut({ repoRoot: repo.root, push: true, skipTests: true, force: true, log: () => {} }),
    /git push .* failed/,
  );

  assert.deepEqual(repo.remoteRefs(), before, 'not one ref moved');
});

test('a failing suite leaves every remote ref untouched', async (t) => {
  const repo = setup(t);
  const before = repo.remoteRefs();

  await assert.rejects(
    () => cut({
      repoRoot: repo.root,
      push: true,
      log: () => {},
      runSuite: (suite) => ({ code: suite.plugin === 'workbench' ? 1 : 0, command: suite.command }),
    }),
    /release suites failed, nothing was published/,
  );

  assert.deepEqual(repo.remoteRefs(), before);
});

test('a failure while building the release leaves every remote ref untouched', async (t) => {
  const repo = setup(t);
  const before = repo.remoteRefs();
  const real = spawnRunner(repo.root);
  const git = createGit({
    cwd: repo.root,
    run: (args) => (args[0] === 'commit' ? { code: 1, stdout: '', stderr: 'forced failure' } : real(args)),
  });

  await assert.rejects(
    () => cut({ repoRoot: repo.root, git, push: true, skipTests: true, log: () => {} }),
    /git commit .* failed/,
  );

  assert.deepEqual(repo.remoteRefs(), before);
});

test('without --push nothing reaches the remote, and the command is printed instead', async (t) => {
  const repo = setup(t);
  const before = repo.remoteRefs();
  const logged = [];

  const result = await cut({ repoRoot: repo.root, skipTests: true, log: (line) => logged.push(line) });

  assert.equal(result.pushed, false);
  assert.deepEqual(repo.remoteRefs(), before);
  assert.ok(logged.join('\n').includes(`git push --atomic origin ${result.commit}:refs/heads/main`));
  assert.match(logged.join('\n'), /refs\/tags\/v3\.208\.0:refs\/tags\/v3\.208\.0/);
});

test('a run that finds nothing to release contacts nothing at all', async (t) => {
  const repo = makeGitRepo({ plugins: PLUGINS });
  t.after(repo.cleanup);
  const calls = [];
  const git = createGit({ cwd: repo.root, onCommand: (entry) => calls.push(entry.args.join(' ')) });

  const result = await cut({ repoRoot: repo.root, git, push: true, skipTests: true, log: () => {} });

  assert.equal(result.status, 'nothing-to-release');
  assert.deepEqual(calls.filter((call) => call.startsWith('push')), []);
  assert.deepEqual(calls.filter((call) => call.startsWith('ls-remote')), [], 'no remote is even read');
});
