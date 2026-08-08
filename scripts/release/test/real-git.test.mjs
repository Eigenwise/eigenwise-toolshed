// Real git, real local `origin`, no network. The recorder tests cover sequencing; these cover the
// claims only git can settle: refspec behaviour, push atomicity, and what a suite can do to the
// refs between verification and publication.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { cut } from '../cut.mjs';
import { loadPlan } from '../plan.mjs';
import { createGit } from '../lib/git.mjs';
import { readValue } from '../lib/jsonedit.mjs';
import { makeGitRepo } from './realrepo.mjs';
import { fragmentText } from './helpers.mjs';

const passing = () => ({ code: 0 });

function setup(t, options) {
  const repo = makeGitRepo(options);
  t.after(repo.cleanup);
  return repo;
}

function version(repo, name) {
  return readValue(readFileSync(path.join(repo.root, `plugins/${name}/.claude-plugin/plugin.json`), 'utf8'), ['version']);
}

async function withEnvironment(entries, action) {
  const previous = new Map(Object.keys(entries).map((name) => [name, process.env[name]]));
  Object.assign(process.env, entries);
  try {
    return await action();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('a real push atomically lands main and the marketplace tag before plugin tags', async (t) => {
  const repo = setup(t);
  repo.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'minor' });
  repo.writeFragment('SQ-2', { plugins: ['workbench'], bump: 'patch' });
  repo.commit('integrate');
  const before = repo.remoteRefs();

  const result = await withEnvironment({
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: 'AUTHORIZATION: basic cmVsZWFzZV90b2tlbl9zZWNyZXQ=',
  }, () => cut({ repoRoot: repo.root, push: true, skipTests: true, log: () => {} }));

  assert.equal(result.status, 'cut');
  assert.deepEqual(result.refspecs, [
    `${result.commit}:refs/heads/main`,
    'refs/tags/v3.208.0:refs/tags/v3.208.0',
    'refs/tags/sidequest-v3.7.0:refs/tags/sidequest-v3.7.0',
    'refs/tags/workbench-v0.63.7:refs/tags/workbench-v0.63.7',
  ]);

  const after = repo.remoteRefs();
  assert.equal(after['refs/heads/main'], result.commit, 'main is the release commit');
  assert.notEqual(after['refs/heads/main'], before['refs/heads/main']);
  for (const tag of result.plan.tags) {
    assert.equal(repo.originGit('rev-list', '-n', '1', `refs/tags/${tag}`), result.commit, `${tag} points at the release commit`);
  }
});

test('a rejected refspec leaves every remote ref exactly where it was', async (t) => {
  const repo = setup(t);
  repo.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'minor' });
  const integration = repo.commit('integrate');

  // Someone already published this window's tag at a different commit, so the tag update is not a
  // fast-forward and git must reject the whole push.
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

test('a suite that moves HEAD stops the release before it is published', async (t) => {
  const repo = setup(t);
  repo.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  repo.commit('integrate');
  const before = repo.remoteRefs();

  await assert.rejects(
    () => cut({
      repoRoot: repo.root,
      push: true,
      log: () => {},
      runSuite: () => {
        repo.git('commit', '-q', '--allow-empty', '-m', 'a suite slipped a commit in');
        return { code: 0 };
      },
    }),
    /HEAD moved from the verified release commit/,
  );

  assert.deepEqual(repo.remoteRefs(), before, 'nothing was published');
});

test('a suite that retargets a release tag stops the release', async (t) => {
  const repo = setup(t);
  repo.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  const integration = repo.commit('integrate');
  const before = repo.remoteRefs();

  await assert.rejects(
    () => cut({
      repoRoot: repo.root,
      push: true,
      log: () => {},
      runSuite: () => {
        repo.git('tag', '-f', 'v3.208.0', integration);
        return { code: 0 };
      },
    }),
    /tag v3\.208\.0 points at .* instead of the verified release commit/,
  );

  assert.deepEqual(repo.remoteRefs(), before);
});

test('a suite that stages files stops the release', async (t) => {
  const repo = setup(t);
  repo.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  repo.commit('integrate');

  await assert.rejects(
    () => cut({
      repoRoot: repo.root,
      push: true,
      log: () => {},
      runSuite: () => {
        writeFileSync(path.join(repo.root, 'plugins/sidequest/sneaky.js'), 'module.exports = 1;\n');
        repo.git('add', 'plugins/sidequest/sneaky.js');
        return { code: 0 };
      },
    }),
    /left staged changes/,
  );
});

test('the suite environment carries no credentials a push could use', async () => {
  const { suiteEnvironment } = await import('../cut.mjs');
  const token = 'release_token_secret';
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  const header = `AUTHORIZATION: basic ${basic}`;
  const env = suiteEnvironment({
    PATH: '/usr/bin',
    GITHUB_TOKEN: 'ghp_secret',
    GH_TOKEN: 'gh_secret',
    NPM_TOKEN: 'npm_secret',
    RELEASE_TOKEN: token,
    SSH_AUTH_SOCK: '/tmp/agent',
    GIT_SSH_COMMAND: 'ssh -i /key',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: header,
    GIT_CONFIG_KEY_1: 'user.email',
    GIT_CONFIG_VALUE_1: 'release@example.test',
    GIT_CONFIG_PARAMETERS: `'http.https://github.com/.extraheader=${header}'`,
    GIT_HTTP_EXTRAHEADER: header,
  });

  for (const name of [
    'GITHUB_TOKEN', 'GH_TOKEN', 'NPM_TOKEN', 'RELEASE_TOKEN', 'SSH_AUTH_SOCK', 'GIT_SSH_COMMAND',
    'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_KEY_1',
    'GIT_CONFIG_VALUE_1', 'GIT_CONFIG_PARAMETERS', 'GIT_HTTP_EXTRAHEADER',
  ]) {
    assert.equal(env[name], undefined, `${name} must not reach a suite`);
  }
  assert.equal(JSON.stringify(env).includes(token), false, 'the token must not survive under another name');
  assert.equal(JSON.stringify(env).includes(basic), false, 'the derived basic credential must not reach a suite');
  assert.equal(JSON.stringify(env).includes(header), false, 'the authorization header must not reach a suite');
  assert.equal(env.PATH, '/usr/bin', 'the rest of the environment survives');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
});

test('a pre-staged file cannot ride into the release commit, even with --allow-dirty', async (t) => {
  const repo = setup(t);
  repo.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  repo.commit('integrate');

  writeFileSync(path.join(repo.root, 'plugins/sidequest/unrelated.js'), 'module.exports = 2;\n');
  repo.git('add', 'plugins/sidequest/unrelated.js');

  await assert.rejects(
    () => cut({ repoRoot: repo.root, allowDirty: true, skipTests: true, log: () => {} }),
    /the index has staged changes .*unrelated\.js/,
  );
  assert.equal(version(repo, 'sidequest'), '3.6.17', 'no version was written');
});

test('--sha plans the pinned commit, not the checkout it runs from', async (t) => {
  const repo = setup(t, { changelog: '# Changelog\n\n## v3.207.0 (2026-07-24)\n\n### sidequest 3.6.16 → 3.6.17\n\n#### Fixes\n- Shipped already (SQ-9)\n' });

  repo.onBranch('dev');
  repo.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'minor' });
  repo.writeFragment('SQ-9', { title: 'Shipped already', plugins: ['workbench'], bump: 'major' });
  const devSha = repo.commit('integrate on dev');

  repo.onBranch('main');
  assert.equal(existsSync(path.join(repo.root, '.release/unreleased/SQ-1.md')), false, 'main has no fragments');

  const dryRun = await cut({ repoRoot: repo.root, sha: devSha, dryRun: true, log: () => {} });

  assert.equal(dryRun.status, 'dry-run');
  assert.equal(dryRun.plan.sha, devSha);
  assert.deepEqual(dryRun.plan.selected.map((fragment) => fragment.ref), ['SQ-1'], 'reads dev fragments from the pin');
  assert.deepEqual(dryRun.plan.skipped, [{ ref: 'SQ-9', reason: 'already released (same fragment content is in CHANGELOG.md; this queued copy is stuck and its note will never ship)' }]);
  assert.deepEqual(dryRun.plan.plugins.map((plugin) => `${plugin.name} ${plugin.to}`), ['sidequest 3.7.0']);

  const real = await cut({ repoRoot: repo.root, sha: devSha, skipTests: true, log: () => {} });
  assert.deepEqual(
    real.plan.plugins.map((plugin) => `${plugin.name} ${plugin.to}`),
    dryRun.plan.plugins.map((plugin) => `${plugin.name} ${plugin.to}`),
    'the dry run described the cut that followed it',
  );
  assert.deepEqual(real.plan.selected.map((fragment) => fragment.ref), ['SQ-1']);
  assert.equal(repo.git('rev-parse', 'HEAD~1'), devSha, 'the release sits directly on the pin');
});

test('a pin that does not contain the publish branch is refused, not silently planned', async (t) => {
  const repo = setup(t);
  repo.onBranch('dev');
  repo.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  const devSha = repo.commit('integrate on dev');

  repo.onBranch('main');
  repo.write('plugins/sidequest/hotfix.js', '// urgent\n');
  repo.commit('main moved on its own');

  await assert.rejects(
    () => cut({ repoRoot: repo.root, sha: devSha, dryRun: true, log: () => {} }),
    /is not an ancestor of the pin .*could not fast-forward; choose a pin descended from main/,
  );
});

test('plan.mjs with --sha reads the pin and without it reads the checkout', async (t) => {
  const repo = setup(t);
  repo.onBranch('dev');
  repo.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'minor' });
  const devSha = repo.commit('integrate on dev');
  repo.onBranch('main');

  const git = createGit({ cwd: repo.root });
  const fromCheckout = loadPlan(repo.root, { git });
  assert.equal(fromCheckout.plan.releasable, false, 'main has nothing queued');
  assert.equal(fromCheckout.plan.source, 'the working tree');

  const fromPin = loadPlan(repo.root, { sha: devSha, git });
  assert.deepEqual(fromPin.plan.selected.map((fragment) => fragment.ref), ['SQ-1']);
  assert.equal(fromPin.plan.source, devSha);
});

test('a marketplace source pointing outside the repository is refused', async (t) => {
  const repo = setup(t);
  const manifestPath = path.join(repo.root, '.claude-plugin/marketplace.json');
  writeFileSync(manifestPath, readFileSync(manifestPath, 'utf8').replace('"./plugins/sidequest"', '"../../victim"'));
  repo.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  repo.commit('integrate');

  await assert.rejects(
    () => cut({ repoRoot: repo.root, skipTests: true, log: () => {} }),
    /source for plugin "sidequest"/,
  );
  assert.equal(existsSync(path.join(repo.base, 'victim')), false, 'nothing was written outside the repo');
});

test('an absolute or dot-segmented source is refused too', async (t) => {
  const repo = setup(t);
  const manifestPath = path.join(repo.root, '.claude-plugin/marketplace.json');
  const original = readFileSync(manifestPath, 'utf8');

  for (const evil of ['/etc', 'plugins/../../escape', './plugins/sidequest/../../..', 'C:/Windows', 'plugins/sidequest/nested']) {
    writeFileSync(manifestPath, original.replace('"./plugins/sidequest"', JSON.stringify(evil)));
    repo.commit(`point sidequest at ${evil}`);
    await assert.rejects(
      () => cut({ repoRoot: repo.root, skipTests: true, log: () => {} }),
      /source for plugin "sidequest"/,
      `expected ${evil} to be refused`,
    );
  }
});

test('a symlinked plugin directory cannot be written through', async (t) => {
  const repo = setup(t);
  repo.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch' });
  repo.commit('integrate');

  const outside = path.join(repo.base, 'outside');
  const link = path.join(repo.root, 'plugins/sidequest');
  mkdirSync(path.join(outside, '.claude-plugin'), { recursive: true });
  writeFileSync(
    path.join(outside, '.claude-plugin/plugin.json'),
    `${JSON.stringify({ name: 'sidequest', version: '3.6.17' }, null, 2)}\n`,
  );

  rmSync(link, { recursive: true, force: true });
  try {
    symlinkSync(outside, link, 'junction');
  } catch {
    t.skip('this platform will not create a directory symlink without extra privileges');
    return;
  }

  await assert.rejects(
    () => cut({ repoRoot: repo.root, skipTests: true, allowDirty: true, log: () => {} }),
    /passes through the symlink "plugins\/sidequest"/,
  );
  assert.equal(
    readValue(readFileSync(path.join(outside, '.claude-plugin/plugin.json'), 'utf8'), ['version']),
    '3.6.17',
    'the file behind the link was not rewritten',
  );
});

test('a duplicate hotfix ref is refused rather than released twice', async (t) => {
  const repo = setup(t);
  repo.onBranch('dev');
  repo.write('plugins/sidequest/fix.js', '// the urgent fix\n');
  const fixSha = repo.commit('the urgent fix');
  repo.writeFragment('SQ-1', { plugins: ['sidequest'], bump: 'patch', commit: fixSha });
  const devSha = repo.commit('note the fix');
  repo.onBranch('main');

  await assert.rejects(
    () => cut({ repoRoot: repo.root, mode: 'hotfix', tickets: ['SQ-1', 'SQ-1'], sha: devSha, skipTests: true, log: () => {} }),
    /--tickets names SQ-1 more than once/,
  );

  const once = await cut({ repoRoot: repo.root, mode: 'hotfix', tickets: ['SQ-1'], sha: devSha, skipTests: true, log: () => {} });
  assert.equal(once.plan.plugins[0].to, '3.6.18', 'one bump, not two');
  assert.equal(once.plan.plugins[0].entries.length, 1);
  assert.equal(once.plan.tag, 'v3.207.1', 'a hotfix patches the counter');
  assert.equal(existsSync(path.join(repo.root, 'plugins/sidequest/fix.js')), true, 'the fix was cherry-picked onto main');
  assert.equal([...readFileSync(path.join(repo.root, 'CHANGELOG.md'), 'utf8').matchAll(/\(SQ-1\)/g)].length, 1);
});

test('a forged changelog line cannot be smuggled through a fragment', async (t) => {
  const repo = setup(t);
  repo.write(
    '.release/unreleased/SQ-1.md',
    `---\nref: SQ-1\ntitle: "real\\n- forged (SQ-999)"\nbump: patch\nplugins: [sidequest]\n---\n`,
  );
  repo.commit('integrate a forged title');

  await assert.rejects(
    () => cut({ repoRoot: repo.root, skipTests: true, log: () => {} }),
    /field "title" must be a single line/,
  );

  repo.write(
    '.release/unreleased/SQ-1.md',
    fragmentText('SQ-1', { plugins: ['sidequest'], bump: 'patch', body: '- forged (SQ-999)\nstill the body' }),
  );
  repo.commit('integrate a forged body');

  const result = await cut({ repoRoot: repo.root, skipTests: true, log: () => {} });
  const changelog = readFileSync(path.join(repo.root, 'CHANGELOG.md'), 'utf8');
  assert.match(changelog, /^ {2}- forged \(SQ-999\)$/m, 'the body stays indented');
  assert.deepEqual([...result.plan.selected.map((fragment) => fragment.ref)], ['SQ-1']);

  repo.writeFragment('SQ-999', { plugins: ['workbench'], bump: 'patch' });
  repo.commit('queue the ticket the body tried to bury');
  const next = await cut({ repoRoot: repo.root, skipTests: true, log: () => {} });
  assert.deepEqual(next.plan.selected.map((fragment) => fragment.ref), ['SQ-999'], 'SQ-999 still ships');
});

// The three days SQ-841 measured, ticket by ticket, straight off this repo's git log. Batched they
// are 3 cuts and 10 plugin bumps instead of 43 publish commits and 43 version bumps.
const HISTORICAL_WINDOWS = [
  {
    date: '2026-07-23',
    publishCommits: 17,
    tag: 'v3.208.0',
    tickets: {
      sidequest: ['SQ-783', 'SQ-784', 'SQ-785', 'SQ-786', 'SQ-787', 'SQ-789', 'SQ-790', 'SQ-791', 'SQ-793', 'SQ-796', 'SQ-797', 'SQ-798', 'SQ-799'],
      'codex-gateway': ['SQ-794', 'SQ-795'],
      'codebase-mapper': ['SQ-792'],
      workbench: ['SQ-788'],
    },
  },
  {
    date: '2026-07-24',
    publishCommits: 19,
    tag: 'v3.209.0',
    tickets: {
      sidequest: ['SQ-800', 'SQ-801', 'SQ-802', 'SQ-804', 'SQ-805', 'SQ-806', 'SQ-807', 'SQ-812', 'SQ-814', 'SQ-815', 'SQ-817', 'SQ-818', 'SQ-820', 'SQ-825'],
      'codex-gateway': ['SQ-810', 'SQ-811', 'SQ-813'],
      workbench: ['SQ-803', 'SQ-819', 'SQ-823'],
    },
  },
  {
    date: '2026-07-25',
    publishCommits: 7,
    tag: 'v3.210.0',
    // The live-rules commit that morning carried no board ref, which is the churn this model
    // removes; under it that work needs a fragment, so the fixture gives it a stand-in.
    tickets: { sidequest: ['SQ-826', 'SQ-834'], workbench: ['SQ-827'], 'live-rules': ['SQ-999'] },
  },
];

test('the three real windows publish three tags and ten plugin bumps to a real remote', async (t) => {
  const repo = setup(t, {
    plugins: { 'codebase-mapper': '2.11.1', 'codex-gateway': '0.33.4', 'live-rules': '2.7.1', sidequest: '3.6.17', workbench: '0.63.6' },
  });

  const bumps = [];
  let publishCommitsReplaced = 0;
  for (const window of HISTORICAL_WINDOWS) {
    for (const [plugin, refs] of Object.entries(window.tickets)) {
      for (const ref of refs) {
        repo.writeFragment(ref, { title: `${plugin} change ${ref}`, plugins: [plugin], bump: 'patch' });
      }
    }
    repo.commit(`integrate ${window.date}`);

    const result = await cut({ repoRoot: repo.root, push: true, skipTests: true, date: window.date, log: () => {} });
    assert.equal(result.plan.tag, window.tag);
    assert.equal(result.plan.selected.length, Object.values(window.tickets).flat().length);
    for (const plugin of result.plan.plugins) bumps.push(`${plugin.name} ${plugin.from} -> ${plugin.to}`);
    assert.equal(repo.remoteRefs()['refs/heads/main'], result.commit);
    publishCommitsReplaced += window.publishCommits;
  }

  assert.equal(publishCommitsReplaced, 43, 'those three days really were 43 publish commits');
  assert.equal(bumps.length, 10, '43 version bumps become 10');
  assert.deepEqual(bumps, [
    'codebase-mapper 2.11.1 -> 2.11.2',
    'codex-gateway 0.33.4 -> 0.33.5',
    'sidequest 3.6.17 -> 3.6.18',
    'workbench 0.63.6 -> 0.63.7',
    'codex-gateway 0.33.5 -> 0.33.6',
    'sidequest 3.6.18 -> 3.6.19',
    'workbench 0.63.7 -> 0.63.8',
    'live-rules 2.7.1 -> 2.7.2',
    'sidequest 3.6.19 -> 3.6.20',
    'workbench 0.63.8 -> 0.63.9',
  ]);
  assert.equal(version(repo, 'codebase-mapper'), '2.11.2', 'thirteen sidequest tickets moved sidequest once, and a one-window plugin once');

  const remote = repo.remoteRefs();
  for (const window of HISTORICAL_WINDOWS) assert.ok(remote[`refs/tags/${window.tag}`], `${window.tag} published`);
  assert.equal(Object.keys(remote).filter((ref) => ref.startsWith('refs/tags/')).length, 13);

  const changelog = readFileSync(path.join(repo.root, 'CHANGELOG.md'), 'utf8');
  assert.deepEqual([...changelog.matchAll(/^## (v[\d.]+) /gm)].map((match) => match[1]), ['v3.210.0', 'v3.209.0', 'v3.208.0']);
  for (const ref of HISTORICAL_WINDOWS.flatMap((window) => Object.values(window.tickets).flat())) {
    assert.match(changelog, new RegExp(`\\(${ref}\\)`), `${ref} is in the changelog`);
  }
  assert.doesNotMatch(readFileSync(path.join(repo.root, 'plugins/sidequest/CHANGELOG.md'), 'utf8'), /SQ-788/, 'a workbench ticket stays out of the sidequest changelog');

  const rerun = await cut({ repoRoot: repo.root, push: true, skipTests: true, log: () => {} });
  assert.equal(rerun.status, 'nothing-to-release');
});
