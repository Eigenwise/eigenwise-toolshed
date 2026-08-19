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
  assert.equal(store.submitTicket(slug, ticket.ref, 'fixture-worker', {
    commit: fixture.submitted,
    gitRef,
    range,
    worktree: fixture.executor,
    verify,
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
  test(`integrate ${mode} rolls back a post-merge verification failure`, () => {
    const { fixture, slug, ticket, runCli } = deliveryTicket(`verify-fail-${mode}`, {
      verify: nodeVerify("console.error('integration verify failure'); process.exit(7)"),
    });
    const before = head(fixture.repo);
    const result = runCli(['integrate', ticket.ref, '--by', 'orchestrator', '--mode', mode, '--json']);

    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.ok(result.stdout, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.delivery, null);
    assert.equal(payload.verifyFailed.status, 'failed_suite');
    assert.equal(payload.verifyFailed.exitCode, 7);
    assert.match(payload.verifyFailed.outputTail, /integration verify failure/);
    assert.ok(fs.existsSync(payload.verifyFailed.logPath));
    const stored = store.getTicket(slug, ticket.ref);
    assert.equal(stored.status, 'doing');
    assert.equal(stored.submission.integration.reason, 'verification_failed_suite_post_merge');
    assert.equal(head(fixture.repo), before);
    assert.equal(git(['status', '--porcelain', '--untracked-files=no'], fixture.repo), '');
    assert.equal(fs.existsSync(path.join(fixture.repo, 'feature.txt')), false);
  });
}

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
  assert.equal(payload.verifyFailed.status, 'timeout');
  assert.equal(payload.verifyFailed.timeoutMilliseconds, 25);
  assert.equal(store.getTicket(slug, ticket.ref).status, 'doing');
});

test('integrate public surfaces honor a bounded verification waiver and refuse a missing payload', async () => {
  const { slug, ticket, runCli } = deliveryTicket('verify-skip', {
    verify: nodeVerify("process.exit(7)"),
  });
  const refused = runCli(['integrate', ticket.ref, '--by', 'orchestrator', '--skip-verify', '--json']);

  assert.equal(refused.status, 1, refused.stderr + refused.stdout);
  const refusedPayload = JSON.parse(refused.stdout);
  assert.equal(refusedPayload.verifyFailed.status, 'skipped');
  assert.deepEqual(refusedPayload.verifyFailed.failureIdentities, ['verification_waiver_required']);
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
