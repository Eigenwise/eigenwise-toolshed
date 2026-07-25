import assert from 'node:assert/strict';
import test from 'node:test';

import { cut } from '../cut.mjs';
import { createGit, mutatesRemote } from '../lib/git.mjs';
import { makeRepo, recordingGit, remoteMutations } from './helpers.mjs';

const PLUGINS = { sidequest: '3.6.17', workbench: '0.63.6' };
const FRAGMENTS = {
  'SQ-1': { plugins: ['sidequest'], bump: 'minor', commit: 'aaaaaaa' },
  'SQ-2': { plugins: ['workbench'], bump: 'patch', commit: 'bbbbbbb' },
};

function setup(t, gitOptions = {}) {
  const repo = makeRepo({ plugins: PLUGINS, fragments: FRAGMENTS, suites: { sidequest: 'package', workbench: 'testdir' } });
  t.after(repo.cleanup);
  const { run, calls } = recordingGit(gitOptions);
  return { root: repo.root, calls, git: createGit({ cwd: repo.root, run }) };
}

test('push is the only verb that can change a remote', () => {
  for (const args of [['merge', '--ff-only', 'x'], ['commit', '-m', 'x'], ['tag', '-a', 'v1'], ['ls-remote', '--tags', 'origin'], ['rev-parse', 'HEAD']]) {
    assert.equal(mutatesRemote(args), false, args.join(' '));
  }
  assert.equal(mutatesRemote(['push', '--atomic', 'origin', 'HEAD:main']), true);
});

test('every remote-changing command happens after the whole release is built', async (t) => {
  const context = setup(t);

  const result = await cut({
    repoRoot: context.root,
    git: context.git,
    push: true,
    runSuite: () => ({ code: 0 }),
    log: () => {},
  });

  assert.equal(result.pushed, true);
  const mutations = remoteMutations(context.calls);
  assert.deepEqual(mutations, ['push --atomic origin HEAD:main v3.208.0 sidequest-v3.7.0 workbench-v0.63.7']);
  assert.equal(context.calls.at(-1), mutations[0], 'the atomic push is the last thing that runs');

  const pushIndex = context.calls.indexOf(mutations[0]);
  for (const verb of ['merge --ff-only', 'commit -m', 'tag -a v3.208.0', 'add --']) {
    const index = context.calls.findIndex((call) => call.startsWith(verb));
    assert.ok(index !== -1 && index < pushIndex, `${verb} must run before the push`);
  }
});

test('one push carries the branch and every tag, so no ref can land alone', async (t) => {
  const context = setup(t);

  const result = await cut({ repoRoot: context.root, git: context.git, push: true, runSuite: () => ({ code: 0 }), log: () => {} });

  const [push] = remoteMutations(context.calls);
  assert.match(push, /^push --atomic origin /);
  assert.ok(push.includes('HEAD:main'));
  for (const tag of result.plan.tags) assert.ok(push.includes(tag), `${tag} must ride the same push`);
  assert.equal(remoteMutations(context.calls).length, 1);
});

test('a failing suite leaves every remote ref untouched', async (t) => {
  const context = setup(t);

  await assert.rejects(
    () => cut({
      repoRoot: context.root,
      git: context.git,
      push: true,
      runSuite: (suite) => ({ code: suite.plugin === 'workbench' ? 1 : 0, command: suite.command }),
      log: () => {},
    }),
    /release suites failed, nothing was published/,
  );

  assert.deepEqual(remoteMutations(context.calls), []);
});

test('a failure while building the release leaves every remote ref untouched', async (t) => {
  const context = setup(t, { failOn: (args) => args[0] === 'commit' });

  await assert.rejects(
    () => cut({ repoRoot: context.root, git: context.git, push: true, runSuite: () => ({ code: 0 }), log: () => {} }),
    /git commit .* failed/,
  );

  assert.deepEqual(remoteMutations(context.calls), []);
});

test('without --push nothing reaches the remote, and the command is printed instead', async (t) => {
  const context = setup(t);
  const logged = [];

  const result = await cut({ repoRoot: context.root, git: context.git, runSuite: () => ({ code: 0 }), log: (line) => logged.push(line) });

  assert.equal(result.pushed, false);
  assert.deepEqual(remoteMutations(context.calls), []);
  assert.match(logged.join('\n'), /git push --atomic origin HEAD:main v3\.208\.0 sidequest-v3\.7\.0 workbench-v0\.63\.7/);
});

test('a run that finds nothing to release contacts nothing at all', async (t) => {
  const repo = makeRepo({ plugins: PLUGINS });
  t.after(repo.cleanup);
  const { run, calls } = recordingGit();

  const result = await cut({
    repoRoot: repo.root,
    git: createGit({ cwd: repo.root, run }),
    push: true,
    runSuite: () => ({ code: 0 }),
    log: () => {},
  });

  assert.equal(result.status, 'nothing-to-release');
  assert.deepEqual(remoteMutations(calls), []);
  assert.deepEqual(calls.filter((call) => call.startsWith('ls-remote')), [], 'no remote is even read');
});
