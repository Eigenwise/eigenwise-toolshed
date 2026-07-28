import './_temp-cleanup.js';
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-advance-home-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;

const store = require('../lib/store.js');
const commitScope = require('../lib/commit-scope.js');
const worktrees = require('../lib/worktrees.js');
const { makeCliRunner } = require('./_helpers.js');

const BIN = path.join(__dirname, '..', 'bin', 'sidequest.js');

const exploration = store.getCategory('codebase-exploration');
store.setCategory(Object.assign({}, exploration, { route: { model: 'sonnet', effort: 'medium' }, fallback: null }));

function git(args: string[], cwd: string) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function head(cwd: string, revision = 'HEAD') {
  return git(['rev-parse', revision], cwd);
}

function commitFile(cwd: string, filename: string, body: string) {
  fs.writeFileSync(path.join(cwd, filename), body);
  git(['add', filename], cwd);
  git(['commit', '-m', `fixture ${filename}`], cwd);
  return head(cwd);
}

function remoteRefs(repo: string) {
  return git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/remotes'], repo);
}

// One fixture, shaped like the real loop: an executor commits in its own agent
// worktree, the orchestrator cherry-picks that range into a separate integration
// checkout and bumps a version on top, and local main is left behind.
function makeRepo(label: string) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `sq-advance-${label}-`));
  git(['init'], repo);
  git(['config', 'user.name', 'Sidequest Test'], repo);
  git(['config', 'user.email', 'sidequest-test@example.invalid'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'advance fixture\n');
  git(['add', '.'], repo);
  git(['commit', '-m', 'base'], repo);
  git(['branch', '-M', 'main'], repo);

  const executor = path.join(repo, '.claude', 'worktrees', 'agent-abc123');
  git(['worktree', 'add', '-b', 'worktree-agent-abc123', executor, 'main'], repo);
  const submitted = commitFile(executor, 'feature.txt', 'executor work\n');

  const integration = path.join(repo, '.claude', 'worktrees', 'integrate');
  git(['worktree', 'add', '-b', 'integration-s16', integration, 'main'], repo);
  git(['cherry-pick', submitted], integration);
  const integrated = commitFile(integration, 'version.txt', '1.2.3\n');

  return { repo, executor, integration, submitted, integrated, target: { mode: 'local', branch: 'main', upstream: 'main' } };
}

function advance(fixture: any, overrides: any = {}) {
  return worktrees.advanceIntegrationBranch(fixture.repo, Object.assign({
    integrationTarget: fixture.target,
    submissionCommit: fixture.submitted,
    submissionWorktree: fixture.executor,
  }, overrides));
}

function submitFixture(slug: string, ticket: any, fixture: any) {
  const gitRef = `refs/sidequest/${ticket.ref}`;
  git(['update-ref', gitRef, fixture.submitted], fixture.executor);
  const target = store.integrationTarget(slug);
  const range = commitScope.submissionRange(fixture.executor, {
    commit: fixture.submitted,
    gitRef,
    upstream: target.upstream,
    integrationBranch: target.branch,
  });
  assert.equal(range.ok, true, JSON.stringify(range));
  assert.equal(store.submitTicket(slug, ticket.ref, 'fixture-worker', {
    commit: fixture.submitted,
    gitRef,
    range,
    worktree: fixture.executor,
    force: true,
  }).ok, true);
}

test('a clean fast-forward advances the local integration branch to the integrated commit', async () => {
  const fixture = makeRepo('clean');
  const before = head(fixture.repo, 'refs/heads/main');
  const refsBefore = remoteRefs(fixture.repo);

  const result = await advance(fixture);

  assert.equal(result.advanced, true, result.message);
  assert.equal(result.reason, 'advanced');
  assert.equal(result.branch, 'main');
  assert.equal(result.from, before);
  assert.equal(result.to, fixture.integrated);
  assert.equal(head(fixture.repo, 'refs/heads/main'), fixture.integrated);
  assert.equal(head(fixture.repo), fixture.integrated, 'the checkout follows its own branch');
  assert.match(result.message, /main/);
  assert.match(result.message, new RegExp(fixture.integrated.slice(0, 12)));
  assert.equal(remoteRefs(fixture.repo), refsBefore, 'no remote ref is written');
  assert.equal(git(['log', '--merges', '--oneline', 'main'], fixture.repo), '', 'never a merge commit');
});

test('advancing a local branch leaves every remote-tracking ref where it was', async () => {
  const fixture = makeRepo('remoterefs');
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-advance-bare-'));
  execFileSync('git', ['init', '--bare', bare], { encoding: 'utf8', windowsHide: true });
  git(['remote', 'add', 'origin', bare], fixture.repo);
  git(['push', '-u', 'origin', 'main'], fixture.repo);
  const refsBefore = remoteRefs(fixture.repo);
  assert.match(refsBefore, /refs\/remotes\/origin\/main/);

  const result = await advance(fixture);

  assert.equal(result.advanced, true, result.message);
  assert.equal(head(fixture.repo, 'refs/heads/main'), fixture.integrated);
  assert.equal(remoteRefs(fixture.repo), refsBefore, 'origin/main still points at the pushed commit');
  assert.equal(git(['rev-parse', 'refs/heads/main'], bare), result.from, 'nothing was pushed');
});

test('a second closure over the same integrated commit is a quiet no-op', async () => {
  const fixture = makeRepo('idempotent');
  assert.equal((await advance(fixture)).advanced, true);

  const result = await advance(fixture);
  assert.equal(result.advanced, false);
  assert.equal(result.reason, 'already_integrated');
  assert.equal(head(fixture.repo, 'refs/heads/main'), fixture.integrated);
});

test('a non-fast-forward refuses, names the branch and commit, and changes nothing', async () => {
  const fixture = makeRepo('diverged');
  const diverged = commitFile(fixture.repo, 'local.txt', 'main moved on its own\n');
  const refsBefore = remoteRefs(fixture.repo);

  const result = await advance(fixture);

  assert.equal(result.advanced, false);
  assert.equal(result.reason, 'not_fast_forward');
  assert.match(result.message, /main/);
  assert.match(result.message, new RegExp(fixture.integrated.slice(0, 12)));
  assert.match(result.message, /do not descend/);
  assert.equal(head(fixture.repo, 'refs/heads/main'), diverged, 'main is untouched');
  assert.equal(remoteRefs(fixture.repo), refsBefore);
});

test('a dirty working tree refuses with the command and changes nothing', async () => {
  const fixture = makeRepo('dirty');
  fs.writeFileSync(path.join(fixture.repo, 'README.md'), 'uncommitted edit\n');
  const before = head(fixture.repo, 'refs/heads/main');

  const result = await advance(fixture);

  assert.equal(result.advanced, false);
  assert.equal(result.reason, 'checkout_dirty');
  assert.match(result.message, /main/);
  assert.match(result.message, new RegExp(fixture.integrated.slice(0, 12)));
  assert.match(result.message, /modified tracked files/);
  assert.equal(result.command, `git -C "${fixture.repo}" merge --ff-only ${fixture.integrated}`);
  assert.equal(head(fixture.repo, 'refs/heads/main'), before);
  assert.equal(git(['status', '--porcelain', '--untracked-files=no'], fixture.repo), 'M README.md', 'the edit survives');
});

test('an untracked file does not block the fast-forward', async () => {
  const fixture = makeRepo('untracked');
  fs.writeFileSync(path.join(fixture.repo, 'scratch.log'), 'ignore me\n');

  const result = await advance(fixture);

  assert.equal(result.advanced, true, result.message);
  assert.equal(head(fixture.repo, 'refs/heads/main'), fixture.integrated);
  assert.equal(fs.readFileSync(path.join(fixture.repo, 'scratch.log'), 'utf8'), 'ignore me\n');
});

test('a checkout sitting on another branch refuses and prints the command to run', async () => {
  const fixture = makeRepo('elsewhere');
  git(['switch', '-c', 'spike'], fixture.repo);
  const before = head(fixture.repo, 'refs/heads/main');

  const result = await advance(fixture);

  assert.equal(result.advanced, false);
  assert.equal(result.reason, 'branch_not_checked_out');
  assert.match(result.message, /main/);
  assert.match(result.message, /"spike" checked out/);
  assert.match(result.message, new RegExp(fixture.integrated.slice(0, 12)));
  assert.equal(
    result.command,
    `git -C "${fixture.repo}" switch main && git -C "${fixture.repo}" merge --ff-only ${fixture.integrated}`,
  );
  assert.equal(head(fixture.repo, 'refs/heads/main'), before, 'main is untouched');
  assert.equal(git(['branch', '--show-current'], fixture.repo), 'spike', 'no branch is checked out for the user');
});

test('a detached main checkout refuses rather than moving the branch behind it', async () => {
  const fixture = makeRepo('detached');
  git(['switch', '--detach', 'main'], fixture.repo);
  const before = head(fixture.repo, 'refs/heads/main');

  const result = await advance(fixture);

  assert.equal(result.reason, 'branch_not_checked_out');
  assert.match(result.message, /detached HEAD/);
  assert.equal(head(fixture.repo, 'refs/heads/main'), before);
});

test('remote mode does nothing at all', async () => {
  const fixture = makeRepo('remote');
  const before = head(fixture.repo, 'refs/heads/main');

  const result = await advance(fixture, { integrationTarget: { mode: 'remote', branch: 'main', upstream: 'origin/main' } });

  assert.equal(result.attempted, false);
  assert.equal(result.advanced, false);
  assert.equal(result.reason, 'remote_mode');
  assert.equal(head(fixture.repo, 'refs/heads/main'), before);
  assert.equal(remoteRefs(fixture.repo), '');
});

test('the executor checkout is never mistaken for the integration', async () => {
  const fixture = makeRepo('executor');
  // The same executor branch, checked out again under a hand-made name so the
  // agent-worktree filter cannot be what saves it.
  const manual = path.join(fixture.repo, '.claude', 'worktrees', 'sq-manual');
  git(['worktree', 'remove', fixture.executor], fixture.repo);
  git(['worktree', 'add', manual, 'worktree-agent-abc123'], fixture.repo);
  git(['worktree', 'remove', fixture.integration], fixture.repo);
  const before = head(fixture.repo, 'refs/heads/main');

  const result = await advance(fixture, { submissionWorktree: manual });

  assert.equal(result.advanced, false);
  assert.equal(result.reason, 'no_integrated_commit');
  assert.match(result.command, /merge --ff-only <integrated-commit>/);
  assert.equal(head(fixture.repo, 'refs/heads/main'), before);
});

test('two checkouts carrying the same work refuse as ambiguous', async () => {
  const fixture = makeRepo('ambiguous');
  const second = path.join(fixture.repo, '.claude', 'worktrees', 'integrate-again');
  git(['worktree', 'add', '-b', 'integration-s17', second, 'main'], fixture.repo);
  git(['cherry-pick', fixture.submitted], second);
  const before = head(fixture.repo, 'refs/heads/main');

  const result = await advance(fixture);

  assert.equal(result.advanced, false);
  assert.equal(result.reason, 'ambiguous_integrated_commit');
  assert.match(result.message, /2 checkouts carry this work/);
  assert.equal(head(fixture.repo, 'refs/heads/main'), before);
});

test('a closure with no submitted commit refuses instead of guessing a target', async () => {
  const fixture = makeRepo('nosubmission');
  const before = head(fixture.repo, 'refs/heads/main');

  const result = await advance(fixture, { submissionCommit: null });

  assert.equal(result.advanced, false);
  assert.equal(result.reason, 'submission_commit_missing');
  assert.match(result.message, /main/);
  assert.equal(head(fixture.repo, 'refs/heads/main'), before);
});

test('a submitted commit missing from the repo refuses instead of guessing a target', async () => {
  const fixture = makeRepo('unresolvable');
  const before = head(fixture.repo, 'refs/heads/main');

  const result = await advance(fixture, { submissionCommit: '0'.repeat(40) });

  assert.equal(result.advanced, false);
  assert.equal(result.reason, 'submission_commit_unresolvable');
  assert.match(result.message, /main/);
  assert.match(result.message, /000000000000 is not in/);
  assert.equal(head(fixture.repo, 'refs/heads/main'), before);
});

test('groom-close --integration advances local main and reports it', async () => {
  const fixture = makeRepo('closure');
  const { slug } = store.ensureProject(fixture.repo);
  const ticket = store.createTicket(slug, {
    title: 'advance fixture',
    category: 'codebase-exploration',
    description: 'A fixture ticket whose integration should advance local main.',
    files: ['feature.txt'],
  });
  submitFixture(slug, ticket, fixture);

  const { runCli } = makeCliRunner(BIN, { SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: fixture.repo }, { cwd: fixture.repo });
  const result = runCli(['groom-close', ticket.ref, '--by', 'orchestrator', '--integration', '--reason', `Integrated ${fixture.integrated}.`]);

  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /advanced main/);
  assert.equal(head(fixture.repo, 'refs/heads/main'), fixture.integrated);
  assert.equal(store.getTicket(slug, ticket.ref).status, 'done');
});

test('groom-close --integration prints the refusal loudly when the checkout is not ready', async () => {
  const fixture = makeRepo('closure-refused');
  fs.writeFileSync(path.join(fixture.repo, 'README.md'), 'uncommitted edit\n');
  const { slug } = store.ensureProject(fixture.repo);
  const ticket = store.createTicket(slug, {
    title: 'refused advance fixture',
    category: 'codebase-exploration',
    description: 'A fixture ticket whose integration cannot advance local main.',
    files: ['feature.txt'],
  });
  submitFixture(slug, ticket, fixture);

  const { runCli } = makeCliRunner(BIN, { SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: fixture.repo }, { cwd: fixture.repo });
  const result = runCli(['groom-close', ticket.ref, '--by', 'orchestrator', '--integration', '--reason', `Integrated ${fixture.integrated}.`, '--json']);

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true, 'the closure itself still succeeds');
  assert.equal(payload.integrationBranch.advanced, false);
  assert.equal(payload.integrationBranch.reason, 'checkout_dirty');
  assert.equal(payload.integrationBranch.branch, 'main');
  assert.match(payload.integrationBranch.command, /merge --ff-only/);
  assert.equal(head(fixture.repo, 'refs/heads/main'), git(['rev-parse', 'main'], fixture.repo));
});

function deliveryTicket(label: string) {
  const fixture = makeRepo(label);
  const { slug } = store.ensureProject(fixture.repo);
  const ticket = store.createTicket(slug, {
    title: `delivery ${label}`,
    category: 'codebase-exploration',
    description: 'A submitted fixture delivered through the integrator command.',
    files: ['feature.txt'],
  });
  submitFixture(slug, ticket, fixture);
  const runner = makeCliRunner(BIN, { SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: fixture.repo }, { cwd: fixture.repo });
  return { fixture, slug, ticket, runCli: runner.runCli };
}

for (const mode of ['merge', 'replay', 'apply']) {
  test(`integrate ${mode} delivers a ready submission and preserves its pinned ref`, () => {
    const { fixture, slug, ticket, runCli } = deliveryTicket(mode);
    const before = head(fixture.repo);
    const result = runCli(['integrate', ticket.ref, '--by', 'orchestrator', '--mode', mode, '--json']);

    assert.equal(result.status, 0, result.stderr + result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.delivery.mode, mode);
    assert.equal(payload.delivery.pinnedRef, `refs/sidequest/${ticket.ref}`);
    assert.equal(payload.delivery.pinnedCommit, fixture.submitted);
    assert.equal(git(['rev-parse', `refs/sidequest/${ticket.ref}`], fixture.repo), fixture.submitted);
    assert.equal(store.getTicket(slug, ticket.ref).status, 'done');
    if (mode === 'apply') {
      assert.equal(head(fixture.repo), before);
      assert.deepEqual(payload.delivery.dirtyFiles, ['feature.txt']);
      assert.equal(fs.readFileSync(path.join(fixture.repo, 'feature.txt'), 'utf8'), 'executor work\n');
    } else {
      assert.notEqual(head(fixture.repo), before);
      assert.equal(fs.readFileSync(path.join(fixture.repo, 'feature.txt'), 'utf8'), 'executor work\n');
    }
  });
}

test('replay conflict aborts, restores HEAD, and keeps the pinned ref', () => {
  const { fixture, slug, ticket, runCli } = deliveryTicket('replay-conflict');
  const before = commitFile(fixture.repo, 'feature.txt', 'conflicting local work\n');

  const result = runCli(['integrate', ticket.ref, '--by', 'orchestrator', '--mode', 'replay', '--json']);

  assert.equal(result.status, 1);
  assert.equal(head(fixture.repo), before);
  assert.equal(git(['status', '--porcelain', '--untracked-files=no'], fixture.repo), '');
  assert.equal(git(['rev-parse', `refs/sidequest/${ticket.ref}`], fixture.repo), fixture.submitted);
  const stored = store.getTicket(slug, ticket.ref);
  assert.equal(stored.status, 'doing');
  assert.equal(stored.submission.integration.failedCommit, fixture.submitted);
});

test('apply refuses an overlapping dirty path and names it without dropping the pinned ref', () => {
  const { fixture, slug, ticket, runCli } = deliveryTicket('apply-overlap');
  fs.writeFileSync(path.join(fixture.repo, 'feature.txt'), 'user edit\n');

  const result = runCli(['integrate', ticket.ref, '--by', 'orchestrator', '--mode', 'apply', '--json']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /apply refused; uncommitted changes overlap submitted paths: feature\.txt/);
  assert.equal(git(['rev-parse', `refs/sidequest/${ticket.ref}`], fixture.repo), fixture.submitted);
  const stored = store.getTicket(slug, ticket.ref);
  assert.equal(stored.status, 'doing');
  assert.deepEqual(stored.submission.integration.dirtyPaths, ['feature.txt']);
});
