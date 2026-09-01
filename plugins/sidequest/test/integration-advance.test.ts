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
const mcp = require('../lib/mcp.js');
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
  git(['init', '-b', 'main'], repo);
  git(['config', 'user.name', 'Sidequest Test'], repo);
  git(['config', 'user.email', 'sidequest-test@example.invalid'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'advance fixture\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.claude/*\n');
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

function submitFixture(slug: string, ticket: any, fixture: any, verify: string | null = null) {
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
  assert.equal(store.claimTicket(slug, ticket.ref, 'fixture-worker', { direct: true, reason: 'The integration fixture requires a local direct claim.' }).ok, true);
  const submitted = store.submitTicket(slug, ticket.ref, 'fixture-worker', {
    commit: fixture.submitted,
    gitRef,
    range,
    worktree: fixture.executor,
    verify,
  });
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
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
  execFileSync('git', ['init', '-b', 'main', '--bare', bare], { encoding: 'utf8', windowsHide: true });
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

test('a scoped integration branch advance leaves unrelated dirty files untouched', async () => {
  const fixture = makeRepo('scoped-dirty');
  const unrelated = path.join(fixture.repo, 'README.md');
  fs.writeFileSync(unrelated, 'user keeps working\n');
  const before = fs.readFileSync(unrelated);

  const result = await advance(fixture, { admittedScope: ['feature.txt'], changedPaths: ['feature.txt'] });

  assert.equal(result.advanced, true, result.message);
  assert.deepEqual(result.ignoredDirtyPaths, ['README.md']);
  assert.deepEqual(fs.readFileSync(unrelated), before);
  assert.equal(git(['status', '--porcelain', '--untracked-files=no'], fixture.repo), 'M README.md');
});

test('a scoped integration branch advance refuses a dirty file inside scope', async () => {
  const fixture = makeRepo('scoped-overlap');
  const scoped = path.join(fixture.repo, 'feature.txt');
  fs.writeFileSync(scoped, 'user edit\n');

  const result = await advance(fixture, { admittedScope: ['feature.txt'], changedPaths: ['feature.txt'] });

  assert.equal(result.advanced, false);
  assert.equal(result.reason, 'checkout_dirty');
  assert.deepEqual(result.dirtyPaths, ['feature.txt']);
  assert.match(result.message, /declared scope: feature\.txt/);
  assert.equal(fs.readFileSync(scoped, 'utf8'), 'user edit\n');
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

test('integrate advances local main and reports it', async () => {
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
  const result = runCli(['integrate', ticket.ref, '--by', 'orchestrator', '--json']);

  assert.equal(result.status, 0, result.stderr + result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.delivery.resultingHead, head(fixture.repo, 'refs/heads/main'));
  assert.equal(payload.delivery.targetBranch, 'main');
  assert.equal(store.getTicket(slug, ticket.ref).status, 'done');
});

test('integrate refuses loudly when the checkout is not ready', async () => {
  const fixture = makeRepo('closure-refused');
  fs.writeFileSync(path.join(fixture.repo, 'feature.txt'), 'uncommitted edit\n');
  const { slug } = store.ensureProject(fixture.repo);
  const ticket = store.createTicket(slug, {
    title: 'refused advance fixture',
    category: 'codebase-exploration',
    description: 'A fixture ticket whose integration cannot advance local main.',
    files: ['feature.txt'],
  });
  submitFixture(slug, ticket, fixture);

  const { runCli } = makeCliRunner(BIN, { SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: fixture.repo }, { cwd: fixture.repo });
  const result = runCli(['integrate', ticket.ref, '--by', 'orchestrator', '--json']);

  assert.equal(result.status, 1, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.reason, 'integration_target_dirty');
  assert.equal(head(fixture.repo, 'refs/heads/main'), git(['rev-parse', 'main'], fixture.repo));
});

function deliveryTicket(label: string, opts: any = {}) {
  const fixture = makeRepo(label);
  const { slug } = store.ensureProject(fixture.repo);
  if (opts.timeoutMs != null) store.setBoardConfig(slug, { integrationVerifyTimeoutMs: opts.timeoutMs });
  const ticket = store.createTicket(slug, {
    title: `delivery ${label}`,
    category: 'codebase-exploration',
    description: 'A submitted fixture delivered through the integrator command.',
    files: opts.files || ['feature.txt'],
    ...(opts.verifyKind ? { executorVerifyKind: opts.verifyKind, executorVerify: opts.verify } : {}),
  });
  submitFixture(slug, ticket, fixture, opts.verify || null);
  const runner = makeCliRunner(BIN, { SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: fixture.repo }, { cwd: fixture.repo });
  return { fixture, slug, ticket, runCli: runner.runCli };
}

test('one passing wave delivers its exact Git participant set before recording delivery', () => {
  const fixture = makeRepo('wave-delivery');
  const secondWorktree = path.join(fixture.repo, '.claude', 'worktrees', 'agent-second');
  git(['worktree', 'add', '-b', 'worktree-agent-second', secondWorktree, 'main'], fixture.repo);
  const secondCommit = commitFile(secondWorktree, 'second.txt', 'second executor work\n');
  const { slug } = store.ensureProject(fixture.repo);
  const first = store.createTicket(slug, {
    title: 'deliver first wave candidate',
    category: 'codebase-exploration',
    description: 'Deliver the first independent candidate.',
    files: ['feature.txt'],
  });
  const second = store.createTicket(slug, {
    title: 'deliver second wave candidate',
    category: 'codebase-exploration',
    description: 'Deliver the second independent candidate.',
    files: ['second.txt'],
  });
  submitFixture(slug, first, fixture);
  const secondRef = `refs/sidequest/${second.ref}`;
  git(['update-ref', secondRef, secondCommit], secondWorktree);
  const target = store.integrationTarget(slug);
  const secondRange = commitScope.submissionRange(secondWorktree, {
    commit: secondCommit,
    gitRef: secondRef,
    upstream: target.upstream,
    integrationBranch: target.branch,
  });
  assert.equal(secondRange.ok, true, JSON.stringify(secondRange));
  assert.equal(store.claimTicket(slug, second.ref, 'second-fixture-worker', { direct: true, reason: 'The integration fixture requires a local direct claim.' }).ok, true);
  assert.equal(store.submitTicket(slug, second.ref, 'second-fixture-worker', {
    commit: secondCommit,
    gitRef: secondRef,
    range: secondRange,
    worktree: secondWorktree,
  }).ok, true);

  const wave = store.assembleSubmissionWave(slug, [first.ref, second.ref], {
    verification: store.getTicket(slug, first.ref).submission.verificationResult,
  });
  assert.equal(wave.ok, true, JSON.stringify(wave));
  assert.equal(wave.gate.state, 'gate_passed');
  const individual = store.integrateSubmission(slug, first.ref, { mode: 'merge', target });
  assert.equal(individual.ok, false);
  assert.equal(individual.reason, 'assembled_wave_delivery_required');

  const { runCli } = makeCliRunner(BIN, { SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: fixture.repo }, { cwd: fixture.repo });
  const result = runCli(['integrate', first.ref, second.ref, '--by', 'orchestrator', '--mode', 'merge', '--json']);

  assert.equal(result.status, 0, result.stderr + result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.delivery.participants, [first.ref, second.ref]);
  assert.equal(head(fixture.repo), payload.delivery.resultingHead);
  assert.equal(fs.readFileSync(path.join(fixture.repo, 'feature.txt'), 'utf8'), 'executor work\n');
  assert.equal(fs.readFileSync(path.join(fixture.repo, 'second.txt'), 'utf8'), 'second executor work\n');
  for (const ticketRef of [first.ref, second.ref]) {
    const stored = store.getTicket(slug, ticketRef);
    assert.equal(stored.status, 'done');
    assert.equal(stored.submission.wave.state, 'delivered');
    assert.equal(stored.submission.integration.outcome, 'verified');
    assert.equal(stored.submission.integration.resultingHead, payload.delivery.resultingHead);
  }
});

test('a refused wave preserves candidates, refuses unrelated grooming delivery, and permits singleton integration', () => {
  const fixture = makeRepo('refused-wave-keeps-candidates');
  const secondWorktree = path.join(fixture.repo, '.claude', 'worktrees', 'agent-conflict');
  git(['worktree', 'add', '-b', 'worktree-agent-conflict', secondWorktree, 'main'], fixture.repo);
  const secondCommit = commitFile(secondWorktree, 'feature.txt', 'conflicting executor work\n');
  const { slug } = store.ensureProject(fixture.repo);
  const first = store.createTicket(slug, {
    title: 'first conflicting wave candidate',
    category: 'codebase-exploration',
    description: 'Keep its submitted candidate after a refused wave.',
    files: ['feature.txt'],
  });
  const second = store.createTicket(slug, {
    title: 'second conflicting wave candidate',
    category: 'codebase-exploration',
    description: 'Conflicts with the first candidate only at wave assembly.',
    files: ['feature.txt'],
  });
  submitFixture(slug, first, fixture);
  const secondRef = `refs/sidequest/${second.ref}`;
  git(['update-ref', secondRef, secondCommit], secondWorktree);
  const target = store.integrationTarget(slug);
  const secondRange = commitScope.submissionRange(secondWorktree, {
    commit: secondCommit,
    gitRef: secondRef,
    upstream: target.upstream,
    integrationBranch: target.branch,
  });
  assert.equal(secondRange.ok, true, JSON.stringify(secondRange));
  assert.equal(store.claimTicket(slug, second.ref, 'conflicting-fixture-worker', { direct: true, reason: 'The conflicting wave fixture needs a direct claim.' }).ok, true);
  assert.equal(store.submitTicket(slug, second.ref, 'conflicting-fixture-worker', {
    commit: secondCommit,
    gitRef: secondRef,
    range: secondRange,
    worktree: secondWorktree,
  }).ok, true);

  const refusal = store.assembleSubmissionWave(slug, [first.ref, second.ref], {
    verification: store.getTicket(slug, first.ref).submission.verificationResult,
  });

  assert.equal(refusal.ok, false);
  assert.equal(refusal.reason, 'wave_invalidated');
  for (const ticketRef of [first.ref, second.ref]) {
    const stored = store.getTicket(slug, ticketRef);
    assert.equal(stored.status, 'todo');
    assert.equal(stored.lifecycleAttempt.state, 'invalidated');
    assert.equal(stored.submission.wave.state, 'invalidated');
  }

  const unrelatedDelivery = commitFile(fixture.repo, 'unrelated.txt', 'unrelated reachable delivery\n');
  const unsafeGroomClose = store.completeTicketAsControlPlane(slug, first.ref, {
    purpose: 'delivery',
    by: 'orchestrator',
    reason: 'An unrelated reachable commit cannot consume the preserved candidate.',
    deliveryCommit: unrelatedDelivery,
  });

  assert.equal(unsafeGroomClose.ok, false);
  assert.equal(unsafeGroomClose.reason, 'delivery_content_missing');
  assert.match(unsafeGroomClose.message, /abandonSubmission: true/);
  const retained = store.getTicket(slug, first.ref);
  assert.equal(retained.status, 'todo');
  assert.equal(retained.submission.commit, fixture.submitted);
  assert.equal(retained.submission.integratedAt, undefined);

  const individual = store.integrateSubmission(slug, first.ref, { mode: 'merge', target });
  assert.equal(individual.ok, true, JSON.stringify(individual));
  assert.equal(individual.integration.mode, 'merge');
});

test('reviewed assembled-wave delivery records a landed source with its verified interaction and refuses unsafe substitutes', () => {
  const verify = nodeVerify("const fs=require('node:fs'); const {execFileSync}=require('node:child_process'); const branch=execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim(); const expected=branch==='main'?'46.41\\n':'executor work\\n'; process.exit(fs.readFileSync('feature.txt','utf8')===expected?0:7)");
  const fixture = makeRepo('reviewed-wave-interaction');
  const { slug } = store.ensureProject(fixture.repo);
  const ticket = store.createTicket(slug, {
    title: 'reviewed merged-tree interaction',
    category: 'codebase-exploration',
    description: 'A candidate whose landed source needs a scoped interaction before merged-tree verification.',
    files: ['feature.txt'],
  });
  submitFixture(slug, ticket, fixture, verify);
  commitFile(fixture.repo, 'source-base.txt', 'main moved before the source replay\n');
  git(['cherry-pick', fixture.submitted], fixture.repo);
  const source = head(fixture.repo);
  const interaction = commitFile(fixture.repo, 'feature.txt', '46.41\n');
  const wave = store.assembleSubmissionWave(slug, [ticket.ref]);
  assert.equal(wave.ok, true, JSON.stringify(wave));
  assert.equal(wave.gate.state, 'gate_passed');

  const missingLineage = store.recordDeliveredSubmission(slug, ticket.ref, {
    target: store.integrationTarget(slug),
    deliveryCommit: fixture.submitted,
    deliveryInteractionCommit: interaction,
    reason: 'This source is not on the integration target.',
  });
  assert.equal(missingLineage.ok, false);
  assert.equal(missingLineage.reason, 'delivery_not_reachable');

  const unrelatedInteraction = commitFile(fixture.repo, 'unrelated.txt', 'substitution\n');
  const unrelated = store.recordDeliveredSubmission(slug, ticket.ref, {
    target: store.integrationTarget(slug),
    deliveryCommit: source,
    deliveryInteractionCommit: unrelatedInteraction,
    reason: 'This interaction changes a path outside the candidate.',
  });
  assert.equal(unrelated.ok, false);
  assert.equal(unrelated.reason, 'delivery_interaction_outside_candidate');

  const delivered = store.recordDeliveredSubmission(slug, ticket.ref, {
    target: store.integrationTarget(slug),
    deliveryCommit: source,
    deliveryInteractionCommit: interaction,
    reason: 'The accepted merged-tree interaction updates the landed candidate expectation.',
  });
  assert.equal(delivered.ok, true, delivered.message);
  assert.equal(delivered.integration.mode, 'recorded-reviewed-interaction');
  assert.equal(delivered.integration.verify.status, 'passed');
  assert.equal(delivered.integration.deliveryIdentity.kind, 'reviewed-merged-tree-interaction');
  assert.equal(delivered.integration.deliveryIdentity.sourceCommit, source);
  assert.equal(delivered.integration.deliveryIdentity.interaction.commit, interaction);
  assert.match(delivered.integration.contentEvidence, /reviewed_merged_tree_interaction/);
  assert.equal(store.getTicket(slug, ticket.ref).submission.wave.delivery.state, 'delivered');

  const ungatedFixture = makeRepo('ungated-reviewed-wave-interaction');
  const { slug: ungatedSlug } = store.ensureProject(ungatedFixture.repo);
  const ungatedTicket = store.createTicket(ungatedSlug, {
    title: 'ungated reviewed merged-tree interaction',
    category: 'codebase-exploration',
    description: 'A candidate that must not use the interaction route without a passing wave.',
    files: ['feature.txt'],
  });
  submitFixture(ungatedSlug, ungatedTicket, ungatedFixture, nodeVerify('process.exit(7)'));
  const ungatedWave = store.assembleSubmissionWave(ungatedSlug, [ungatedTicket.ref]);
  assert.equal(ungatedWave.ok, false);
  assert.equal(ungatedWave.reason, 'assembled_wave_gate_failed');
  const ungatedSource = commitFile(ungatedFixture.repo, 'feature.txt', 'landed source\n');
  const ungatedInteraction = commitFile(ungatedFixture.repo, 'feature.txt', 'landed interaction\n');
  const ungated = store.recordDeliveredSubmission(ungatedSlug, ungatedTicket.ref, {
    target: store.integrationTarget(ungatedSlug),
    deliveryCommit: ungatedSource,
    deliveryInteractionCommit: ungatedInteraction,
    reason: 'The wave gate was never accepted.',
  });
  assert.equal(ungated.ok, false);
  assert.equal(ungated.reason, 'assembled_wave_gate_required');
});

test('control-plane delivery validates a reviewed interaction and keeps no-submission reachable closure', () => {
  const refusedFixture = makeRepo('control-plane-refused-interaction');
  const { slug: refusedSlug } = store.ensureProject(refusedFixture.repo);
  const refusedTicket = store.createTicket(refusedSlug, {
    title: 'refuse unrelated reviewed interaction delivery',
    category: 'codebase-exploration',
    description: 'A submitted candidate must not close against unrelated reachable delivery evidence.',
    files: ['feature.txt'],
  });
  submitFixture(refusedSlug, refusedTicket, refusedFixture);
  const unrelatedSource = commitFile(refusedFixture.repo, 'unrelated.txt', 'unrelated reachable source\n');

  const refused = store.completeTicketAsControlPlane(refusedSlug, refusedTicket.ref, {
    purpose: 'delivery',
    by: 'orchestrator',
    reason: 'An unrelated source and invalid interaction cannot consume the candidate.',
    deliveryCommit: unrelatedSource,
    deliveryInteractionCommit: 'deadbeef',
  });

  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'delivery_content_missing');
  const retained = store.getTicket(refusedSlug, refusedTicket.ref);
  assert.equal(retained.status, 'doing');
  assert.equal(retained.submission.commit, refusedFixture.submitted);
  assert.equal(retained.submission.integratedAt, undefined);

  const reviewedVerify = nodeVerify("const fs=require('node:fs'); const {execFileSync}=require('node:child_process'); const branch=execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim(); const expected=branch==='main'?'reviewed result\\n':'executor work\\n'; process.exit(fs.readFileSync('feature.txt','utf8')===expected?0:7)");
  const reviewedFixture = makeRepo('control-plane-reviewed-interaction');
  const { slug: reviewedSlug } = store.ensureProject(reviewedFixture.repo);
  const reviewedTicket = store.createTicket(reviewedSlug, {
    title: 'accept reviewed descendant interaction delivery',
    category: 'codebase-exploration',
    description: 'A reviewed descendant interaction closes through the recorded-delivery validator.',
    files: ['feature.txt'],
  });
  submitFixture(reviewedSlug, reviewedTicket, reviewedFixture, reviewedVerify);
  git(['cherry-pick', reviewedFixture.submitted], reviewedFixture.repo);
  const reviewedSource = head(reviewedFixture.repo);
  const reviewedInteraction = commitFile(reviewedFixture.repo, 'feature.txt', 'reviewed result\n');

  const delivered = store.completeTicketAsControlPlane(reviewedSlug, reviewedTicket.ref, {
    purpose: 'delivery',
    by: 'orchestrator',
    reason: 'The reviewed descendant is present and verified on the integration tree.',
    deliveryCommit: reviewedSource,
    deliveryInteractionCommit: reviewedInteraction,
  });

  assert.equal(delivered.ok, true, delivered.message);
  const reviewed = store.getTicket(reviewedSlug, reviewedTicket.ref);
  assert.equal(reviewed.status, 'done');
  assert.equal(reviewed.submission.integration.mode, 'recorded-reviewed-interaction');
  assert.equal(reviewed.submission.integration.deliveryIdentity.sourceCommit, reviewedSource);
  assert.equal(reviewed.submission.integration.deliveryIdentity.interaction.commit, reviewedInteraction);
  assert.equal(reviewed.submission.integration.verify.status, 'passed');
  assert.equal(reviewed.submission.wave.delivery.state, 'delivered');

  const ordinaryFixture = makeRepo('control-plane-ordinary-reachable');
  const { slug: ordinarySlug } = store.ensureProject(ordinaryFixture.repo);
  const ordinaryTicket = store.createTicket(ordinarySlug, {
    title: 'preserve ordinary reachable delivery closure',
    category: 'codebase-exploration',
    description: 'A reachable hand delivery without a submitted candidate keeps its existing closure path.',
    files: ['feature.txt'],
  });
  const ordinaryDelivery = commitFile(ordinaryFixture.repo, 'ordinary.txt', 'ordinary reachable delivery\n');

  const ordinary = store.completeTicketAsControlPlane(ordinarySlug, ordinaryTicket.ref, {
    purpose: 'delivery',
    by: 'orchestrator',
    reason: 'The ordinary reachable delivery remains supported without a submission.',
    deliveryCommit: ordinaryDelivery,
  });

  assert.equal(ordinary.ok, true, ordinary.message);
  assert.equal(store.getTicket(ordinarySlug, ordinaryTicket.ref).status, 'done');
  assert.equal(ordinary.ticket.completion.delivery.commit, ordinaryDelivery);
});

for (const mode of ['merge', 'replay', 'apply']) {
  test(`integrate ${mode} delivers a ready submission and preserves its pinned ref`, () => {
    const { fixture, slug, ticket, runCli } = deliveryTicket(mode);
    const before = head(fixture.repo);
    const result = runCli(['integrate', ticket.ref, '--by', 'orchestrator', '--mode', mode, '--json']);

    assert.equal(result.status, 0, result.stderr + result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.verify.status, 'passed');
    assert.match(payload.ticket.completion.reason, /Verify passed:/);
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

function nodeVerify(source: string) {
  return `"${process.execPath}" -e "${source.replace(/"/g, '\\"')}"`;
}

for (const mode of ['merge', 'replay', 'apply']) {
  test(`integrate ${mode} verifies the delivered result`, () => {
    const { fixture, slug, ticket, runCli } = deliveryTicket(`verify-result-${mode}`, {
      verify: nodeVerify("require('node:fs').accessSync('feature.txt')"),
    });
    const before = head(fixture.repo);
    const result = runCli(['integrate', ticket.ref, '--by', 'orchestrator', '--mode', mode, '--json']);

    assert.equal(result.status, 0, result.stderr + result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.verify.status, 'passed');
    assert.ok(fs.existsSync(payload.verify.logPath));
    assert.equal(store.getTicket(slug, ticket.ref).status, 'done');
    if (mode === 'apply') assert.equal(head(fixture.repo), before);
    else assert.notEqual(head(fixture.repo), before);
  });
}

for (const mode of ['merge', 'replay', 'apply']) {
  test(`integrate ${mode} refuses delivery when the assembled-wave gate fails`, () => {
    const { fixture, slug, ticket, runCli } = deliveryTicket(`verify-fail-${mode}`, {
      verify: nodeVerify("console.error('integration verify failure'); process.exit(7)"),
    });
    const before = head(fixture.repo);
    const result = runCli(['integrate', ticket.ref, '--by', 'orchestrator', '--mode', mode, '--json']);

    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.ok(result.stdout, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.delivery, null);
    assert.equal(payload.reason, 'assembled_wave_gate_failed');
    assert.equal(payload.gate.verification.status, 'failed_suite');
    assert.equal(payload.gate.verification.exitCode, 7);
    assert.match(payload.gate.verification.outputTail, /integration verify failure/);
    assert.ok(fs.existsSync(payload.gate.verification.logPath));
    const stored = store.getTicket(slug, ticket.ref);
    assert.equal(stored.status, 'doing');
    assert.equal(stored.submission.integration, undefined);
    assert.equal(head(fixture.repo), before);
    assert.equal(git(['status', '--porcelain', '--untracked-files=no'], fixture.repo), '');
    assert.equal(fs.existsSync(path.join(fixture.repo, 'feature.txt')), false);
  });
}

test('post-merge verification rolls back a rebuilt committed output to its recorded pre-merge head', () => {
  const fixture = makeRepo('post-merge-rebuilt-output');
  fixture.submitted = commitFile(fixture.executor, 'generated-output.js', 'candidate generated output\n');
  const verify = nodeVerify("const fs=require('node:fs'); const {execFileSync}=require('node:child_process'); const branch=execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim(); fs.writeFileSync('generated-output.js',branch==='main'?'rebuilt generated output\\n':'candidate generated output\\n'); if(branch==='main') process.exit(7)");
  const { slug } = store.ensureProject(fixture.repo);
  const ticket = store.createTicket(slug, {
    title: 'rollback rebuilt generated output',
    category: 'codebase-exploration',
    description: 'A delivery fixture whose post-merge verifier rebuilds a committed output before failing.',
    files: ['feature.txt', 'generated-output.js'],
  });
  submitFixture(slug, ticket, fixture);
  store.updateTicket(slug, ticket.ref, { executorVerifyKind: 'suite', executorVerify: verify });
  const before = head(fixture.repo);

  const result = store.integrateSubmission(slug, ticket.ref, { mode: 'merge', target: fixture.target });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'verification_failed_suite_post_merge');
  assert.equal(result.before, before);
  assert.equal(head(fixture.repo), before);
  assert.equal(git(['status', '--porcelain=v2', '--untracked-files=all'], fixture.repo), '');
  assert.equal(fs.existsSync(path.join(fixture.repo, 'generated-output.js')), false);
  const integration = store.getTicket(slug, ticket.ref).submission.integration;
  assert.equal(integration.reason, 'verification_failed_suite_post_merge');
  assert.equal(integration.rollback.strategy, 'hard-reset-delivery-head');
  assert.match(integration.message, /rolled back delivery/);
});

test('post-merge verification refuses a hard reset after an extra main commit', () => {
  const fixture = makeRepo('post-merge-extra-commit');
  const verify = nodeVerify("const fs=require('node:fs'); const {execFileSync}=require('node:child_process'); const branch=execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim(); if(branch==='main'){fs.writeFileSync('verify-extra.txt','unexpected main commit\\n'); execFileSync('git',['add','verify-extra.txt']); execFileSync('git',['commit','-m','verify extra commit']); process.exit(7)}");
  const { slug } = store.ensureProject(fixture.repo);
  const ticket = store.createTicket(slug, {
    title: 'refuse reset after extra commit',
    category: 'codebase-exploration',
    description: 'A delivery fixture whose verifier advances main after the delivery merge.',
    files: ['feature.txt'],
  });
  submitFixture(slug, ticket, fixture);
  store.updateTicket(slug, ticket.ref, { executorVerifyKind: 'suite', executorVerify: verify });
  const before = head(fixture.repo);

  const result = store.integrateSubmission(slug, ticket.ref, { mode: 'merge', target: fixture.target });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'verification_failed_suite_post_merge_rollback_failed');
  assert.notEqual(head(fixture.repo), before);
  assert.equal(git(['status', '--porcelain=v2', '--untracked-files=all'], fixture.repo), '');
  assert.match(result.message, /main STILL CONTAINS the delivered merge/);
  assert.match(result.message, /manual recovery/i);
});

test('integrate finalizes after a passing recorded verification command', () => {
  const { slug, ticket, runCli } = deliveryTicket('verify-pass', {
    verify: nodeVerify("console.log('integration verify passed')"),
  });
  const result = runCli(['integrate', ticket.ref, '--by', 'orchestrator', '--json']);

  assert.equal(result.status, 0, result.stderr + result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.verify.status, 'passed');
  assert.equal(payload.verify.outputTail, undefined);
  assert.ok(fs.existsSync(payload.verify.logPath));
  assert.equal(store.getTicket(slug, ticket.ref).status, 'done');
});

test('document verification integrates submitted evidence without invoking the process runner', () => {
  const evidence = 'updated guide explains X';
  const { slug, ticket, runCli } = deliveryTicket('verify-document', {
    verify: evidence,
    verifyKind: 'document',
  });
  const result = runCli(['integrate', ticket.ref, '--by', 'orchestrator', '--json']);

  assert.equal(result.status, 0, result.stderr + result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.verify.kind, 'document');
  assert.equal(payload.verify.status, 'passed');
  assert.equal(payload.verify.evidence, evidence);
  assert.equal(payload.verify.command, undefined);
  assert.equal(payload.verify.logPath, undefined);
  assert.match(payload.ticket.completion.reason, new RegExp(evidence));
  assert.equal(store.getTicket(slug, ticket.ref).submission.integration.verify.evidence, evidence);
});

test('manual verification closes with the executor evidence', () => {
  const evidence = 'manual: executor inspected the rendered guide';
  const { slug, ticket, runCli } = deliveryTicket('verify-manual', {
    verify: evidence,
    verifyKind: 'manual',
  });
  const result = runCli(['integrate', ticket.ref, '--by', 'orchestrator', '--json']);

  assert.equal(result.status, 0, result.stderr + result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.verify.status, 'manual');
  assert.equal(payload.verify.evidence, evidence);
  assert.match(payload.ticket.completion.reason, new RegExp(evidence));
  assert.doesNotMatch(payload.ticket.completion.reason, /undefined/);
  assert.equal(store.getTicket(slug, ticket.ref).completion.reason, payload.ticket.completion.reason);
});

test('integrate refuses delivery when recorded verification times out', () => {
  const { slug, ticket, runCli } = deliveryTicket('verify-timeout', {
    verify: nodeVerify('setTimeout(() => {}, 1000)'),
    timeoutMs: 25,
  });
  const result = runCli(['integrate', ticket.ref, '--by', 'orchestrator', '--json']);

  assert.equal(result.status, 1, result.stderr + result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.delivery, null);
  assert.equal(payload.reason, 'assembled_wave_gate_failed');
  assert.equal(payload.gate.verification.status, 'timeout');
  assert.equal(payload.gate.verification.timeoutMilliseconds, 25);
  assert.equal(store.getTicket(slug, ticket.ref).status, 'doing');
});

test('integrate public surfaces honor a bounded verification waiver and refuse a missing payload', async () => {
  const { slug, ticket, runCli } = deliveryTicket('verify-skip', {
    verify: nodeVerify("process.exit(7)"),
  });
  const refused = runCli(['integrate', ticket.ref, '--by', 'orchestrator', '--skip-verify', '--json']);

  assert.equal(refused.status, 1, refused.stderr + refused.stdout);
  const refusedPayload = JSON.parse(refused.stdout);
  assert.equal(refusedPayload.reason, 'verification_waiver_required');
  assert.match(refusedPayload.message, /human waiver with authority, reason, affectedGate/);
  assert.equal(refusedPayload.gate, undefined);
  assert.equal(store.getTicket(slug, ticket.ref).status, 'doing');

  const accepted = runCli([
    'integrate', ticket.ref,
    '--by', 'orchestrator',
    '--skip-verify',
    '--waiver-authority', 'release-manager',
    '--waiver-reason', 'vendor verifier outage',
    '--waiver-gate', 'integration-suite',
    '--waiver-scope', ticket.ref,
    '--json',
  ]);

  assert.equal(accepted.status, 0, accepted.stderr + accepted.stdout);
  const acceptedPayload = JSON.parse(accepted.stdout);
  assert.equal(acceptedPayload.verify.status, 'skipped');
  assert.equal(acceptedPayload.verify.waiver.authority, 'release-manager');
  assert.deepEqual(acceptedPayload.verify.diagnostics, [{
    code: 'verification_waived',
    message: 'Verification gate integration-suite waived by release-manager: vendor verifier outage',
    actionable: true,
  }]);
  const stored = store.getTicket(slug, ticket.ref);
  assert.equal(stored.status, 'done');
  assert.deepEqual(stored.submission.integration.verify.diagnostics, acceptedPayload.verify.diagnostics);

  const mcpFixture = deliveryTicket('verify-skip-mcp', {
    verify: nodeVerify("process.exit(7)"),
  });
  const mcpResponse = await mcp.handleRequest({
    jsonrpc: '2.0',
    id: 2247,
    method: 'tools/call',
    params: {
      name: 'integrate',
      arguments: {
        project: mcpFixture.fixture.repo,
        ref: mcpFixture.ticket.ref,
        by: 'orchestrator',
        skipVerify: true,
        verificationWaiver: {
          authority: 'release-manager',
          reason: 'vendor verifier outage',
          affectedGate: 'integration-suite',
          scope: mcpFixture.ticket.ref,
        },
      },
    },
  });
  assert.ok(mcpResponse.result, JSON.stringify(mcpResponse));
  assert.ok(!mcpResponse.result.isError, mcpResponse.result.content?.[0]?.text);
  const mcpPayload = JSON.parse(mcpResponse.result.content[0].text);
  assert.equal(mcpPayload.ok, true, JSON.stringify(mcpPayload));
  assert.equal(mcpPayload.verify.status, 'skipped');
  assert.equal(mcpPayload.verify.diagnostics[0].code, 'verification_waived');
  assert.deepEqual(
    store.getTicket(mcpFixture.slug, mcpFixture.ticket.ref).submission.integration.verify.diagnostics,
    mcpPayload.verify.diagnostics,
  );
});

function makeUnmergedTarget(repo: string, label: string) {
  const currentBranch = git(['branch', '--show-current'], repo);
  const competingBranch = `unmerged-${label}`;
  git(['branch', competingBranch], repo);
  commitFile(repo, 'target-conflict.txt', 'current target\n');
  git(['checkout', competingBranch], repo);
  commitFile(repo, 'target-conflict.txt', 'competing target\n');
  git(['checkout', currentBranch], repo);
  assert.throws(() => git(['merge', competingBranch], repo));
}

const dirtyIntegrationTargetStates = [
  ['unstaged', (fixture: any) => fs.writeFileSync(path.join(fixture.repo, 'README.md'), 'unstaged target edit\n')],
  ['staged', (fixture: any) => {
    fs.writeFileSync(path.join(fixture.repo, 'README.md'), 'staged target edit\n');
    git(['add', 'README.md'], fixture.repo);
  }],
  ['untracked', (fixture: any) => fs.writeFileSync(path.join(fixture.repo, 'target-scratch.log'), 'untracked target file\n')],
  ['unmerged', (fixture: any, ticket: any) => makeUnmergedTarget(fixture.repo, ticket.ref)],
] as const;

for (const [state, dirtyTarget] of dirtyIntegrationTargetStates) {
  test(`integrate refuses a ${state} target without changing the pending submission`, () => {
    const { fixture, slug, ticket } = deliveryTicket(`dirty-target-${state}`);
    dirtyTarget(fixture, ticket);
    const checkoutBefore = git(['status', '--porcelain=v2', '--untracked-files=all'], fixture.repo);
    const submissionBefore = store.getTicket(slug, ticket.ref).submission;
    const headBefore = head(fixture.repo);

    const result = store.integrateSubmission(slug, ticket.ref, { mode: 'merge', target: fixture.target });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'integration_target_dirty');
    if (state === 'untracked') assert.match(result.message, /target-scratch\.log/);
    assert.equal(git(['status', '--porcelain=v2', '--untracked-files=all'], fixture.repo), checkoutBefore);
    assert.equal(head(fixture.repo), headBefore);
    assert.deepEqual(store.getTicket(slug, ticket.ref).submission, submissionBefore);
    assert.equal(git(['rev-parse', `refs/sidequest/${ticket.ref}`], fixture.repo), fixture.submitted);
  });
}

function makeGreenfieldRepo(label: string, locked = true) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `sq-greenfield-${label}-`));
  git(['init', '-b', 'main'], repo);
  git(['config', 'user.name', 'Sidequest Test'], repo);
  git(['config', 'user.email', 'sidequest-test@example.invalid'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'greenfield fixture\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.claude/*\n');
  git(['add', '.'], repo);
  git(['commit', '-m', 'base'], repo);
  git(['branch', '-M', 'main'], repo);

  const executor = path.join(repo, '.claude', 'worktrees', 'agent-greenfield');
  git(['worktree', 'add', '-b', 'worktree-agent-greenfield', executor, 'main'], repo);
  const pluginDirectory = path.join(executor, 'plugins', 'greenfield');
  fs.mkdirSync(path.join(pluginDirectory, 'locked-dependency'), { recursive: true });
  fs.mkdirSync(path.join(pluginDirectory, 'test'), { recursive: true });
  fs.writeFileSync(path.join(pluginDirectory, 'package.json'), JSON.stringify({
    name: 'greenfield',
    private: true,
    scripts: { 'test:full': 'node --test test/greenfield.test.js' },
    ...(locked ? { devDependencies: { 'locked-dependency': 'file:./locked-dependency' } } : {}),
  }));
  if (locked) {
    fs.writeFileSync(path.join(pluginDirectory, 'package-lock.json'), JSON.stringify({
      name: 'greenfield',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: 'greenfield', devDependencies: { 'locked-dependency': 'file:./locked-dependency' } },
        'locked-dependency': { version: '1.0.0', dev: true },
        'node_modules/locked-dependency': { resolved: 'locked-dependency', link: true },
      },
    }));
    fs.writeFileSync(path.join(pluginDirectory, 'locked-dependency', 'package.json'), JSON.stringify({ name: 'locked-dependency', version: '1.0.0' }));
    fs.writeFileSync(path.join(pluginDirectory, 'locked-dependency', 'index.js'), "module.exports = 'locked';\n");
  }
  fs.writeFileSync(
    path.join(pluginDirectory, 'test', 'greenfield.test.js'),
    locked ? "require('node:assert').equal(require('locked-dependency'), 'locked');\n" : "require('node:assert').ok(true);\n",
  );
  git(['add', 'plugins'], executor);
  git(['commit', '-m', 'add greenfield plugin'], executor);
  const submitted = head(executor);

  return { repo, executor, submitted, target: { mode: 'local', branch: 'main', upstream: 'main' } };
}

test('integration does not derive a suite for an unprepared greenfield submission', () => {
  const fixture = makeGreenfieldRepo('locked-dependencies');
  const { slug } = store.ensureProject(fixture.repo);
  const ticket = store.createTicket(slug, {
    title: 'greenfield package',
    category: 'codebase-exploration',
    description: 'A new locked package requires its dependencies during integration.',
    files: ['plugins/greenfield'],
  });
  submitFixture(slug, ticket, fixture);
  const { runCli } = makeCliRunner(BIN, { SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: fixture.repo }, { cwd: fixture.repo });

  assert.equal(fs.existsSync(path.join(fixture.repo, 'plugins', 'greenfield', 'node_modules')), false);
  const result = runCli(['integrate', ticket.ref, '--by', 'orchestrator', '--json']);

  assert.equal(result.status, 0, result.stderr + result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.verify.status, 'passed');
  assert.equal(payload.verify.kind, 'custom');
  assert.equal(fs.existsSync(path.join(fixture.repo, 'plugins', 'greenfield', 'node_modules')), false);
});

test('integration does not derive an unlocked greenfield suite after submission', () => {
  const fixture = makeGreenfieldRepo('missing-lock', false);
  const { slug } = store.ensureProject(fixture.repo);
  const ticket = store.createTicket(slug, {
    title: 'unlocked greenfield package',
    category: 'codebase-exploration',
    description: 'A package without a lockfile cannot use mutable dependency resolution.',
    files: ['plugins/greenfield'],
  });
  submitFixture(slug, ticket, fixture);
  const { runCli } = makeCliRunner(BIN, { SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: fixture.repo }, { cwd: fixture.repo });

  const result = runCli(['integrate', ticket.ref, '--by', 'orchestrator', '--json']);

  assert.equal(result.status, 0, result.stderr + result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.verify.status, 'passed');
  assert.equal(payload.verify.kind, 'custom');
  assert.equal(fs.existsSync(path.join(fixture.repo, 'plugins', 'greenfield', 'node_modules')), false);
});
