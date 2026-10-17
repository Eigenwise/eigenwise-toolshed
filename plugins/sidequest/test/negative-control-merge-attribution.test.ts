import './_temp-cleanup.js';
import './_sidequest-install-fixture.js';
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { execFileSync } = childProcess;

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-negative-control-merge-home-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;
process.env.CLAUDE_PROJECT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-negative-control-merge-unused-'));

const store = require('../lib/store.js');

const codingNormal = store.getCategory('coding.normal');
store.setCategory(Object.assign({}, codingNormal, { route: { model: 'sonnet', effort: 'medium' }, fallback: null }));

// The candidate works on main; develop is the integration branch other tickets land on.
function fixtureProject(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const git = (arguments_: string[]) => execFileSync('git', arguments_, { cwd: dir, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  };
  const commit = (files: Record<string, string>, message: string) => {
    for (const [file, content] of Object.entries(files)) write(file, content);
    git(['add', '.']);
    git(['commit', '-m', message]);
    return git(['rev-parse', 'HEAD']);
  };
  const land = (files: Record<string, string>, message: string) => {
    git(['checkout', 'develop']);
    commit(files, message);
    git(['checkout', 'main']);
  };
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Sidequest Test']);
  git(['config', 'user.email', 'sidequest-test@example.invalid']);
  commit({
    'lib/fixture.js': 'module.exports = 1;\n',
    'test/fixture.test.js': "test('shared test', () => {\n  shared();\n});\n\ntest('resolution test', () => {\n  resolution();\n});\n",
  }, 'base');
  git(['branch', 'develop']);
  const { slug } = store.ensureProject(dir);
  return { dir, git, write, commit, land, slug };
}

function claimSharedTree(slug: string, by: string, integration: Record<string, string> = { integrationBranch: 'develop', integrationMode: 'local' }) {
  const ticket = store.createTicket(slug, {
    title: 'negative control merge attribution fixture',
    description: 'Where: negative-control merge fixture. Contract: demand markers only for the candidate\'s own test changes. Verify: inspect completion.',
    category: 'coding.normal',
    files: ['lib', 'test'],
    source: 'test',
  });
  const sessionId = `${ticket.ref}-session`;
  const prepared = store.prepareDispatch(slug, ticket.ref, { sharedTree: true, sessionId, ...integration });
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    sessionId,
    agentName: prepared.ticket.dispatch.launchName,
    source: 'test',
  }).ok, true);
  assert.equal(store.claimTicket(slug, ticket.ref, by, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    sessionId,
    source: 'test',
  }).ok, true);
  return ticket;
}

const control = '[sidequest:negative-control] target=lib/fixture.js:1; assertion=fixture returns the changed value; npm run test:files test/own.test.js failed=1 failure-kind=assertion';
const verified = '[sidequest:verify-complete] passed: fixture verification passed.';
const ownWork = {
  'lib/fixture.js': 'module.exports = 2;\n',
  'test/own.test.js': "test('own change test', () => {\n  own();\n});\n",
};

test('GH-160: a merge from the integration branch demands markers only for the candidate\'s own tests and its conflict resolution', () => {
  const { git, write, commit, land, slug } = fixtureProject('sq-negative-control-merge-');
  const by = 'merge-attribution-executor';
  const ticket = claimSharedTree(slug, by);

  commit(ownWork, 'own work');
  land({
    'test/other.test.js': "test('other ticket test', () => {\n  other();\n});\n",
    'test/fixture.test.js': "test('shared test', () => {\n  sharedByOtherTicket();\n});\n\ntest('resolution test', () => {\n  resolution();\n});\n",
  }, 'another ticket');
  git(['merge', '--no-edit', 'develop']);

  assert.equal(store.addComment(slug, ticket.ref, { by, body: `${control}\n[sidequest:negative-control-test] failed own change test`, source: 'mcp' }).ok, true);
  const completion = store.addComment(slug, ticket.ref, { by, body: verified, source: 'mcp' });
  assert.equal(completion.ok, true, completion.message);

  land({ 'test/third.test.js': "test('third ticket test', () => {\n  third();\n});\n" }, 'third ticket');
  git(['merge', '--no-commit', '--no-ff', 'develop']);
  write('test/fixture.test.js', "test('shared test', () => {\n  sharedByOtherTicket();\n});\n\ntest('resolution test', () => {\n  resolvedInTheMerge();\n});\n");
  git(['add', '.']);
  git(['commit', '--no-edit']);

  const refusal = store.addComment(slug, ticket.ref, { by, body: verified, source: 'mcp' });
  assert.equal(refusal.reason, 'negative_control_test_required');
  assert.match(refusal.message, /resolution test/);
  assert.doesNotMatch(refusal.message, /third ticket test|other ticket test|shared test/);
});

test('GH-160: a branch merged from outside the integration branch is still the candidate\'s own work', () => {
  const { git, commit, slug } = fixtureProject('sq-negative-control-side-merge-');
  const by = 'side-merge-attribution-executor';
  const ticket = claimSharedTree(slug, by);

  git(['checkout', '-b', 'side']);
  commit(ownWork, 'own work on a side branch');
  git(['checkout', 'main']);
  git(['merge', '--no-ff', '--no-edit', 'side']);

  assert.equal(store.addComment(slug, ticket.ref, { by, body: control, source: 'mcp' }).ok, true);
  const refusal = store.addComment(slug, ticket.ref, { by, body: verified, source: 'mcp' });
  assert.equal(refusal.reason, 'negative_control_test_required');
  assert.match(refusal.message, /own change test/);
});

test('GH-160: own work merged onto the integration branch tip keeps its tests and drops the integration branch\'s', () => {
  const { git, commit, land, slug } = fixtureProject('sq-negative-control-replay-');
  const by = 'replay-attribution-executor';
  const ticket = claimSharedTree(slug, by);

  commit(ownWork, 'own work');
  land({ 'test/other.test.js': "test('other ticket test', () => {\n  other();\n});\n" }, 'another ticket');
  git(['branch', 'own-work']);
  git(['reset', '--hard', 'develop']);
  git(['merge', '--no-ff', '--no-edit', 'own-work']);

  assert.equal(store.addComment(slug, ticket.ref, { by, body: control, source: 'mcp' }).ok, true);
  const refusal = store.addComment(slug, ticket.ref, { by, body: verified, source: 'mcp' });
  assert.equal(refusal.reason, 'negative_control_test_required');
  assert.match(refusal.message, /own change test/);
  assert.doesNotMatch(refusal.message, /other ticket test/);
});

test('GH-160: submit attributes from the dispatch base whatever range base it is given', () => {
  const { commit, slug } = fixtureProject('sq-negative-control-range-base-');
  const by = 'range-base-attribution-executor';
  // The default target is main, the branch this shared tree commits on, so every own commit is on it.
  const ticket = claimSharedTree(slug, by, {});

  const first = commit(ownWork, 'own work');
  const candidate = commit({ 'lib/fixture.js': 'module.exports = 3;\n' }, 'more own work');
  assert.equal(store.addComment(slug, ticket.ref, { by, body: control, source: 'mcp' }).ok, true);

  const atCandidate = store.submitTicket(slug, ticket.ref, by, {
    commit: candidate,
    range: { base: candidate, upstream: 'main', upstreamCommit: candidate, commits: [], changedPaths: [], noOp: true },
  });
  assert.equal(atCandidate.reason, 'negative_control_test_required', atCandidate.message);
  assert.match(atCandidate.message, /own change test/);

  const afterOwnTest = store.submitTicket(slug, ticket.ref, by, {
    commit: candidate,
    range: { base: first, upstream: 'main', upstreamCommit: candidate, commits: [candidate], changedPaths: ['lib/fixture.js'] },
  });
  assert.equal(afterOwnTest.reason, 'negative_control_test_required', afterOwnTest.message);
  assert.match(afterOwnTest.message, /own change test/);
});

test('GH-160: a merge answers only for lines no parent had, not a parent\'s side of a union or an upstream file it kept', () => {
  const { git, write, commit, land, slug } = fixtureProject('sq-negative-control-union-');
  const by = 'union-attribution-executor';
  const baseTest = "test('base test', () => {\n  base();\n});\n";
  const ownAppended = "test('own appended test', () => {\n  own();\n});\n";
  const upstreamAppended = "test('upstream appended test', () => {\n  up();\n});\n";
  commit({ 'test/union.test.js': baseTest }, 'union base');
  git(['branch', '-f', 'develop', 'HEAD']);
  const ticket = claimSharedTree(slug, by);

  commit({ 'lib/fixture.js': 'module.exports = 2;\n', 'test/union.test.js': baseTest + ownAppended }, 'own work');
  land({
    'test/union.test.js': baseTest + upstreamAppended,
    'test/up.test.js': "test('up test A', () => {\n  a();\n});\n\ntest('up test B', () => {\n  b();\n});\n",
  }, 'upstream tests');
  assert.throws(() => git(['merge', '--no-edit', 'develop']));
  write('test/union.test.js', baseTest + ownAppended + upstreamAppended);
  write('test/up.test.js', "test('up test A', () => {\n  a();\n});\n\ntest('up test B', () => {\n  resolvedB();\n});\n");
  git(['add', '.']);
  git(['commit', '--no-edit']);

  assert.equal(store.addComment(slug, ticket.ref, { by, body: `${control}\n[sidequest:negative-control-test] failed own appended test`, source: 'mcp' }).ok, true);
  const refusal = store.addComment(slug, ticket.ref, { by, body: verified, source: 'mcp' });
  assert.equal(refusal.reason, 'negative_control_test_required');
  assert.match(refusal.message, /up test B/);
  assert.doesNotMatch(refusal.message, /up test A|upstream appended test/);

  assert.equal(store.addComment(slug, ticket.ref, { by, body: '[sidequest:negative-control-test] failed up test B', source: 'mcp' }).ok, true);
  const completion = store.addComment(slug, ticket.ref, { by, body: verified, source: 'mcp' });
  assert.equal(completion.ok, true, completion.message);
});

test('GH-160: a test only a merge\'s hand edit changed still needs its marker', () => {
  for (const source of ['side', 'develop']) {
    const { git, write, commit, land, slug } = fixtureProject(`sq-negative-control-hand-edit-${source}-`);
    const by = `hand-edit-${source}-executor`;
    const ticket = claimSharedTree(slug, by);

    commit({ 'lib/fixture.js': 'module.exports = 2;\n' }, 'own work');
    if (source === 'develop') {
      land({ 'lib/upstream.js': 'module.exports = 1;\n' }, 'another ticket');
    } else {
      git(['checkout', '-b', 'side', 'HEAD~1']);
      commit({ 'lib/side.js': 'module.exports = 1;\n' }, 'side work');
      git(['checkout', 'main']);
    }
    git(['merge', '--no-commit', '--no-ff', source]);
    write('test/fixture.test.js', "test('shared test', () => {\n  shared();\n});\n\ntest('resolution test', () => {\n  editedOnlyInTheMerge();\n});\n");
    git(['add', '.']);
    git(['commit', '--no-edit']);

    assert.equal(store.addComment(slug, ticket.ref, { by, body: control, source: 'mcp' }).ok, true);
    const refusal = store.addComment(slug, ticket.ref, { by, body: verified, source: 'mcp' });
    assert.equal(refusal.reason, 'negative_control_test_required', `${source}: ${refusal.message}`);
    assert.match(refusal.message, /resolution test/);
    assert.doesNotMatch(refusal.message, /shared test/);
  }
});

test('GH-160: commits fast-forwarded from the integration branch are not the candidate\'s', () => {
  const { git, commit, land, slug } = fixtureProject('sq-negative-control-ff-');
  const by = 'fast-forward-attribution-executor';
  const ticket = claimSharedTree(slug, by);

  land({ 'test/delivered.test.js': "test('already delivered ticket test', () => {\n  delivered();\n});\n" }, 'already delivered ticket');
  git(['merge', '--ff-only', 'develop']);
  commit({
    'lib/fixture.js': 'module.exports = 3;\n',
    'test/own.test.js': "test('own fast-forward test', () => {\n  own();\n});\n",
  }, 'own work');

  assert.equal(store.addComment(slug, ticket.ref, { by, body: control, source: 'mcp' }).ok, true);
  const refusal = store.addComment(slug, ticket.ref, { by, body: verified, source: 'mcp' });
  assert.equal(refusal.reason, 'negative_control_test_required');
  assert.match(refusal.message, /own fast-forward test/);
  assert.doesNotMatch(refusal.message, /already delivered ticket test/);

  assert.equal(store.addComment(slug, ticket.ref, { by, body: '[sidequest:negative-control-test] failed own fast-forward test', source: 'mcp' }).ok, true);
  const completion = store.addComment(slug, ticket.ref, { by, body: verified, source: 'mcp' });
  assert.equal(completion.ok, true, completion.message);
});

// A fork PR rework's integration branch is the PR branch, which upstream develop's commits never reach.
// The board's integration branch is develop, so a remote's develop is the reviewed line; any other
// remote-tracking ref is a pushed branch nobody has reviewed. A null remoteRef leaves the branch local.
function mergeFromBranch(project: ReturnType<typeof fixtureProject>, remoteRef: string | null) {
  const { git, write, commit } = project;
  const upstreamWork = {
    'test/upstream.test.js': "test('upstream develop test', () => {\n  upstream();\n});\n",
    'test/fixture.test.js': "test('shared test', () => {\n  sharedUpstream();\n});\n\ntest('resolution test', () => {\n  resolution();\n});\n",
  };
  git(['branch', 'pr']);
  git(['checkout', '-b', 'upstream-work']);
  const tip = commit(upstreamWork, 'upstream develop');
  git(['checkout', 'main']);
  assert.equal(store.setBoardConfig(project.slug, { integrationBranch: 'develop' }).ok, true);
  if (remoteRef) {
    git(['update-ref', remoteRef, tip]);
    git(['branch', '-D', 'upstream-work']);
  }
  return {
    write,
    merge: (resolve?: () => void) => {
      git(['merge', '--no-commit', '--no-ff', tip]);
      resolve?.();
      git(['add', '.']);
      git(['commit', '--no-edit']);
    },
  };
}

const prBranch = { integrationBranch: 'pr', integrationMode: 'local' };

test('SQ-176: tests merged in from a remote\'s copy of the integration branch are not the candidate\'s', () => {
  const project = fixtureProject('sq-negative-control-published-');
  const by = 'published-merge-executor';
  const { merge } = mergeFromBranch(project, 'refs/remotes/upstream/develop');
  const ticket = claimSharedTree(project.slug, by, prBranch);

  project.commit(ownWork, 'own work');
  merge();

  assert.equal(store.addComment(project.slug, ticket.ref, { by, body: `${control}\n[sidequest:negative-control-test] failed own change test`, source: 'mcp' }).ok, true);
  const completion = store.addComment(project.slug, ticket.ref, { by, body: verified, source: 'mcp' });
  assert.equal(completion.ok, true, completion.message);
});

test('SQ-176: a test only the resolution of a remote integration branch merge changed is still demanded', () => {
  const project = fixtureProject('sq-negative-control-published-resolution-');
  const by = 'published-resolution-executor';
  const { merge, write } = mergeFromBranch(project, 'refs/remotes/upstream/develop');
  const ticket = claimSharedTree(project.slug, by, prBranch);

  project.commit(ownWork, 'own work');
  merge(() => write('test/fixture.test.js', "test('shared test', () => {\n  sharedUpstream();\n});\n\ntest('resolution test', () => {\n  resolvedInTheMerge();\n});\n"));

  assert.equal(store.addComment(project.slug, ticket.ref, { by, body: `${control}\n[sidequest:negative-control-test] failed own change test`, source: 'mcp' }).ok, true);
  const refusal = store.addComment(project.slug, ticket.ref, { by, body: verified, source: 'mcp' });
  assert.equal(refusal.reason, 'negative_control_test_required');
  assert.match(refusal.message, /resolution test/);
  assert.doesNotMatch(refusal.message, /upstream develop test|shared test/);
});

test('SQ-176: tests merged in from a local-only branch or a pushed feature branch are still the candidate\'s own', () => {
  for (const [shape, remoteRef] of [['local-only', null], ['pushed-feature', 'refs/remotes/origin/some-feature']] as const) {
    const project = fixtureProject(`sq-negative-control-${shape}-`);
    const by = `${shape}-merge-executor`;
    const { merge } = mergeFromBranch(project, remoteRef);
    const ticket = claimSharedTree(project.slug, by, prBranch);

    project.commit(ownWork, 'own work');
    merge();

    assert.equal(store.addComment(project.slug, ticket.ref, { by, body: control, source: 'mcp' }).ok, true);
    const refusal = store.addComment(project.slug, ticket.ref, { by, body: verified, source: 'mcp' });
    assert.equal(refusal.reason, 'negative_control_test_required', `${shape}: ${refusal.message}`);
    assert.match(refusal.message, /upstream develop test/);
    assert.match(refusal.message, /own change test/);
  }
});

test('GH-160 follow-up: a merge develop made internally is not the candidate\'s, so merging develop alone leaves an empty scope', () => {
  const { git, write, commit, slug } = fixtureProject('sq-negative-control-inherited-merge-');
  const by = 'inherited-merge-executor';
  const ticket = claimSharedTree(slug, by);

  git(['checkout', '-b', 'feature', 'develop']);
  commit({ 'docs/feature.md': 'feature\n' }, 'feature outside scope');
  git(['checkout', 'develop']);
  commit({ 'docs/develop.md': 'develop\n' }, 'develop outside scope');
  git(['merge', '--no-commit', '--no-ff', 'feature']);
  write('lib/fixture.js', 'module.exports = 9;\n');
  git(['add', '.']);
  git(['commit', '--no-edit']);
  git(['checkout', 'main']);
  git(['merge', '--no-ff', '--no-edit', 'develop']);

  const refusal = store.addComment(slug, ticket.ref, { by, body: verified, source: 'mcp' });
  assert.equal(refusal.reason, 'empty_declared_scope', refusal.message);
});

test('GH-160 follow-up: a merge diffs only the in-scope paths it touched, never every path both sides changed', (t: any) => {
  const { git, commit, land, slug } = fixtureProject('sq-negative-control-merge-spawns-');
  const notes = (first: string, last: string) => `${first}\nb\nc\nd\n${last}\n`;
  commit({ 'docs/notes.md': notes('a', 'e') }, 'notes');
  git(['branch', '-f', 'develop']);
  const by = 'merge-spawn-executor';
  const ticket = claimSharedTree(slug, by);

  commit({ 'docs/notes.md': notes('own', 'e'), 'test/fixture.test.js': "test('shared test', () => {\n  ownShared();\n});\n\ntest('resolution test', () => {\n  resolution();\n});\n" }, 'own work');
  land({ 'docs/notes.md': notes('a', 'upstream'), 'test/fixture.test.js': "test('shared test', () => {\n  shared();\n});\n\ntest('resolution test', () => {\n  upstreamResolution();\n});\n" }, 'another ticket');
  git(['merge', '--no-edit', 'develop']);

  const spawns = t.mock.method(childProcess, 'execFileSync');
  store.addComment(slug, ticket.ref, { by, body: verified, source: 'mcp' });
  const perPathDiffs = spawns.mock.calls
    .map((call: any) => call.arguments[1] as string[])
    .filter((arguments_: string[]) => arguments_[0] === 'diff-tree' && arguments_.includes('--unified=0'))
    .map((arguments_: string[]) => arguments_[arguments_.length - 1]);
  assert.deepEqual([...new Set(perPathDiffs)], ['test/fixture.test.js']);
});
