import './_temp-cleanup.js';
import './_sidequest-install-fixture.js';
import './_hook-runtime.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const store = require('../lib/store.js');
const kernel = require('../lib/kernel/worktree.js');
const mcp = require('../lib/mcp.js');

function fixture(checkoutName = 'integration') {
  const repository = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-integration-checkout-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Sidequest Test');
  git('config', 'user.email', 'sidequest-test@example.invalid');
  fs.writeFileSync(path.join(repository, 'README.md'), 'base\n');
  git('add', 'README.md');
  git('commit', '-m', 'fixture');
  fs.appendFileSync(path.join(repository, '.git/info/exclude'), '\n/.worktrees/\n');
  const checkout = path.join(repository, '.worktrees', checkoutName);
  git('worktree', 'add', '-b', 'delivery', checkout, 'main');
  const { slug } = store.ensureProject(repository);
  store.setCategory({ id: 'integration-checkout.fixture', name: 'Integration checkout fixture', route: { model: 'sonnet', effort: 'medium' }, enabled: true });
  function prepare(options: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
    const ticket = store.createTicket(slug, { title: 'Integration checkout fixture', category: 'integration-checkout.fixture', files: ['README.md'], ...extra });
    const previous = process.cwd();
    process.chdir(repository);
    try {
      const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: `${slug}-${ticket.ref}`, sharedTree: true, integrationBranch: 'delivery', integrationCheckout: checkout, ...options });
      assert.equal(prepared.ok, true, prepared.message);
      return prepared;
    } finally {
      process.chdir(previous);
    }
  }
  return { repository, checkout, slug, git, prepare };
}

async function submittedFixture(f: ReturnType<typeof fixture>, failTarget: boolean | string = false, options: { file?: string; command?: string; marker?: string } = {}) {
  const evidence = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-integration-oracle-'));
  const marker = path.join(evidence, 'cwd');
  const script = path.join(evidence, 'verify.cjs');
  const targetAction = typeof failTarget === 'string' ? failTarget : "fs.writeFileSync('README.md', 'verification edits\\n'); process.exitCode = 1;";
  fs.writeFileSync(script, `const fs = require('node:fs');\nfs.appendFileSync(${JSON.stringify(marker)}, process.cwd() + '\\n');\nif (${Boolean(failTarget)} && process.cwd() === ${JSON.stringify(f.checkout)}) { ${targetAction} }\n`);
  const command = options.command || `"${process.execPath}" "${script}"`;
  const file = options.file || 'README.md';
  const prepared = f.prepare({}, { files: [file], executorVerify: command, executorVerifyKind: 'command' });
  const ticket = prepared.ticket;
  const owner = `${f.slug}-${ticket.ref}`;
  assert.equal(store.recordDispatchLaunch(f.slug, ticket.ref, { token: prepared.token, executor: ticket.dispatchExecutor, sessionId: ticket.dispatch.sessionId }).ok, true);
  assert.equal(store.claimTicket(f.slug, ticket.ref, owner, { token: prepared.token, executor: ticket.dispatchExecutor, sessionId: ticket.dispatch.sessionId }).ok, true);
  f.git('switch', '-c', `candidate-${ticket.ref}`);
  fs.writeFileSync(path.join(f.repository, file), 'candidate\n');
  f.git('add', file);
  f.git('commit', '-m', 'candidate fixture');
  const commit = f.git('rev-parse', 'HEAD');
  f.git('update-ref', `refs/sidequest/${ticket.ref}`, commit);
  const { runVerifyCapture, recordCapture } = require('../lib/verify-capture.js');
  const capture = await runVerifyCapture(command, f.repository);
  assert.equal(capture.status, 'passed');
  const recorded = recordCapture({ project: f.repository, ticket: ticket.ref }, capture, f.repository);
  assert.equal(recorded.ok, true, recorded.message);
  const submission = await mcp.TOOLS.find((tool: any) => tool.name === 'submit').handler({ project: f.repository, ref: ticket.ref, by: owner, commit, worktree: f.repository, verify: command, body: 'Verified integration-checkout fixture.' });
  assert.equal(submission.ok, true, submission.message);
  f.git('switch', 'main');
  return { ticket: store.getTicket(f.slug, ticket.ref), marker: options.marker || marker, commit, command };
}

test('integration checkout delivery and verification leave the registered shared checkout untouched', async () => {
  const f = fixture();
  const before = f.git('rev-parse', 'main');
  const { ticket, marker } = await submittedFixture(f);
  const result = store.integrateSubmission(f.slug, ticket.ref, { mode: 'merge' });
  assert.equal(result.ok, true, result.message);
  assert.equal(f.git('rev-parse', 'HEAD'), before);
  assert.equal(f.git('branch', '--show-current'), 'main');
  assert.equal(fs.readFileSync(path.join(f.repository, 'README.md'), 'utf8'), 'base\n');
  assert.equal(fs.readFileSync(path.join(f.checkout, 'README.md'), 'utf8'), 'candidate\n');
  assert.equal(fs.readFileSync(marker, 'utf8').trim().split('\n').at(-1), f.checkout);
  assert.equal(result.integration.targetCheckout.path, f.checkout);
});

test('integration checkout verification rollback restores only the pinned checkout', async () => {
  const f = fixture();
  const before = f.git('rev-parse', 'main');
  const { ticket } = await submittedFixture(f, true);
  const result = store.integrateSubmission(f.slug, ticket.ref, { mode: 'merge' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'verification_failed_suite_post_merge');
  assert.equal(result.rollback.strategy, 'hard-reset-delivery-head');
  assert.equal(f.git('-C', f.checkout, 'rev-parse', 'HEAD'), before);
  assert.equal(f.git('rev-parse', 'HEAD'), before);
  assert.equal(f.git('-C', f.checkout, 'status', '--porcelain'), '');
});

test('integration checkout manual reconciliation ignores a caller replacement target', async () => {
  const f = fixture();
  const before = f.git('rev-parse', 'main');
  const { ticket, commit, marker } = await submittedFixture(f);
  f.git('-C', f.checkout, 'merge', '--ff-only', commit);
  const result = store.recordDeliveredSubmission(f.slug, ticket.ref, {
    target: { mode: 'local', branch: 'main', upstream: 'main' }, deliveryCommit: commit, reason: 'Fixture delivery onto the pinned checkout.',
  });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.integration.targetCheckout.path, f.checkout);
  assert.equal(fs.readFileSync(marker, 'utf8').trim().split('\n').at(-1), f.checkout);
  assert.equal(f.git('rev-parse', 'HEAD'), before);
});

test('integration checkout abandonment recognizes delivery on its frozen target', async () => {
  const f = fixture();
  const { ticket, commit } = await submittedFixture(f);
  f.git('-C', f.checkout, 'merge', '--ff-only', commit);
  const result = store.recordAbandonedSubmission(f.slug, ticket.ref, {
    target: { mode: 'local', branch: 'main', upstream: 'main' }, reason: 'Check whether the candidate already landed.',
  });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.integration.mode, 'already-landed');
  assert.equal(result.integration.targetCheckout.path, f.checkout);
});

test('integration checkout rollback refuses a replacement created during verification', async () => {
  const f = fixture();
  const action = `const git = args => require('node:child_process').execFileSync('git', args, {cwd: ${JSON.stringify(f.repository)}, stdio: 'pipe'}); git(['worktree', 'remove', '--force', ${JSON.stringify(f.checkout)}]); git(['worktree', 'add', ${JSON.stringify(f.checkout)}, 'delivery']); fs.writeFileSync(${JSON.stringify(path.join(f.checkout, 'README.md'))}, 'foreign replacement\\n'); process.exitCode = 1;`;
  const { ticket } = await submittedFixture(f, action);
  const result = store.integrateSubmission(f.slug, ticket.ref, { mode: 'merge' });
  assert.equal(result.ok, false);
  assert.equal(result.rollback.strategy, 'refused');
  assert.equal(fs.readFileSync(path.join(f.checkout, 'README.md'), 'utf8'), 'foreign replacement\n');
  assert.equal(fs.readFileSync(path.join(f.repository, 'README.md'), 'utf8'), 'base\n');
});

test('integration checkout never falls back to shared main when its path disappears', async () => {
  const f = fixture();
  const { ticket } = await submittedFixture(f);
  f.git('worktree', 'remove', f.checkout);
  f.git('switch', 'delivery');
  const before = f.git('rev-parse', 'HEAD');
  const result = store.integrateSubmission(f.slug, ticket.ref, { mode: 'merge' });
  assert.equal(result.ok, false);
  assert.match(result.message, /integrationCheckout/);
  assert.equal(f.git('rev-parse', 'HEAD'), before);
});

test('integration checkout rejects mixed-checkout targets on the same branch', () => {
  const f = fixture();
  const second = path.join(f.repository, '.worktrees/second-integration');
  f.git('worktree', 'add', '--force', second, 'delivery');
  const firstTicket = f.prepare().ticket;
  const secondTicket = f.prepare({ integrationCheckout: second }).ticket;
  const result = store.ticketIntegrationTargets(f.slug, [firstTicket, secondTicket]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'integration_target_mismatch');
});

test('integration checkout permits head advancement but refuses a replaced checkout', () => {
  const f = fixture();
  const ticket = f.prepare().ticket;
  f.git('-C', f.checkout, 'commit', '--allow-empty', '-m', 'normal target advancement');
  assert.equal(store.ticketIntegrationTarget(f.slug, ticket).checkout.path, f.checkout);
  f.git('worktree', 'remove', f.checkout);
  f.git('worktree', 'add', f.checkout, 'delivery');
  const gitDirectory = f.git('-C', f.checkout, 'rev-parse', '--absolute-git-dir');
  kernel.createCheckoutInstanceMarker(gitDirectory);
  assert.throws(() => store.ticketIntegrationTarget(f.slug, ticket), /integrationCheckout.*identity/);
});

test('integration checkout delivers an assembled wave only into the selected checkout', async () => {
  const f = fixture();
  const before = f.git('rev-parse', 'HEAD');
  const first = await submittedFixture(f);
  const second = await submittedFixture(f, false, { file: 'second.txt', command: first.command, marker: first.marker });
  const refs = [first.ticket.ref, second.ticket.ref];
  const assembly = store.assembleSubmissionWave(f.slug, refs);
  assert.equal(assembly.ok, true, assembly.message);
  const result = store.integrateSubmissionWave(f.slug, refs, { mode: 'merge' });
  assert.equal(result.ok, true, result.message);
  assert.equal(f.git('rev-parse', 'HEAD'), before);
  assert.equal(fs.existsSync(path.join(f.repository, 'second.txt')), false);
  assert.equal(fs.readFileSync(path.join(f.checkout, 'second.txt'), 'utf8'), 'candidate\n');
  assert.equal(fs.readFileSync(first.marker, 'utf8').trim().split('\n').at(-1), f.checkout);
});

[0, 1].forEach((exitCode) => test(`integration checkout wave rollback refuses a clean replacement after verifier exit ${exitCode}`, async () => {
  const f = fixture();
  const before = f.git('rev-parse', 'HEAD');
  const action = `const git = args => require('node:child_process').execFileSync('git', args, {cwd: ${JSON.stringify(f.repository)}, stdio: 'pipe'}); git(['worktree', 'remove', '--force', ${JSON.stringify(f.checkout)}]); git(['worktree', 'add', ${JSON.stringify(f.checkout)}, 'delivery']); process.exitCode = ${exitCode};`;
  const first = await submittedFixture(f, action);
  const second = await submittedFixture(f, false, { file: 'second.txt', command: first.command });
  const refs = [first.ticket.ref, second.ticket.ref];
  const assembly = store.assembleSubmissionWave(f.slug, refs);
  assert.equal(assembly.ok, true, assembly.message);
  const result = store.integrateSubmissionWave(f.slug, refs, { mode: 'merge' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /rollback_failed$/);
  assert.notEqual(f.git('-C', f.checkout, 'rev-parse', 'HEAD'), before);
  assert.equal(f.git('rev-parse', 'HEAD'), before);
  assert.equal(result.deliveryHead, f.git('rev-parse', 'delivery'));
  assert.equal(result.rollback.strategy, 'refused');
  assert.match(result.message, /Delivery .* may still be present/);
}));

test('integration checkout rejects successful verification on a replaced checkout', async () => {
  const f = fixture();
  const action = `const git = args => require('node:child_process').execFileSync('git', args, {cwd: ${JSON.stringify(f.repository)}, stdio: 'pipe'}); git(['worktree', 'remove', '--force', ${JSON.stringify(f.checkout)}]); git(['worktree', 'add', ${JSON.stringify(f.checkout)}, 'delivery']);`;
  const { ticket } = await submittedFixture(f, action);
  const result = store.integrateSubmission(f.slug, ticket.ref, { mode: 'merge' });
  assert.equal(result.ok, false, 'verification must not bless a replacement checkout');
  assert.notEqual(f.git('rev-parse', 'delivery'), f.git('rev-parse', 'main'));
  assert.equal(result.before, f.git('rev-parse', 'main'));
  assert.equal(result.deliveryHead, f.git('rev-parse', 'delivery'));
  assert.notEqual(result.deliveryHead, result.before);
  assert.equal(result.rollback.strategy, 'refused');
  assert.match(result.reason, /post_merge_rollback_failed$/);
  assert.match(result.message, /Delivery .* may still be present/);
  assert.notEqual(store.getTicket(f.slug, ticket.ref).submission.integration.outcome, 'delivered');
});

test('integration checkout cached verification refuses a replaced delivery checkout', async () => {
  const f = fixture();
  const { ticket } = await submittedFixture(f);
  assert.equal(store.integrateSubmission(f.slug, ticket.ref, { mode: 'merge' }).ok, true);
  f.git('worktree', 'remove', f.checkout);
  f.git('worktree', 'add', f.checkout, 'delivery');
  const result = store.verifyIntegration(f.slug, ticket.ref);
  assert.equal(result.ok, false, 'cached verification is not authority for a replacement checkout');
});

test('integration checkout CLI dispatch pins the requested branch and path', () => {
  const f = fixture();
  const ticket = store.createTicket(f.slug, { title: 'CLI checkout fixture', category: 'integration-checkout.fixture', files: ['README.md'],
    description: 'Where: README.md in the fixture repository. Contract: preserve the declared delivery checkout and branch at dispatch. Verify: inspect the stored checkout identity and use the Node version command as a bounded fixture verifier.', executorVerify: 'node --version', executorVerifyKind: 'command' });
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../bin/sidequest.js'), 'dispatch', ticket.ref,
    '--project', f.repository, '--session', `${f.slug}-cli`, '--shared-tree', '--integration-branch', 'delivery',
    '--integration-checkout', f.checkout, '--unverified-transport', '--json'], {
    cwd: f.repository, env: { ...process.env, CLAUDE_PROJECT_DIR: f.repository }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(store.getTicket(f.slug, ticket.ref).dispatch.integrationTarget.checkout.path, f.checkout);
});

test('integration checkout MCP delivery uses the pinned checkout end to end', async () => {
  const f = fixture();
  const before = f.git('rev-parse', 'HEAD');
  const { ticket } = await submittedFixture(f);
  const result = await mcp.TOOLS.find((tool: any) => tool.name === 'integrate').handler({ project: f.repository, ref: ticket.ref, by: 'fixture-integrator', mode: 'merge' });
  assert.equal(result.ok, true, result.message);
  assert.equal(store.getTicket(f.slug, ticket.ref).status, 'done');
  assert.equal(f.git('rev-parse', 'HEAD'), before);
});

test('integration checkout advancement revalidates the pinned identity', async () => {
  const f = fixture();
  const target = f.prepare().ticket.dispatch.integrationTarget;
  const worktrees = require('../lib/worktrees.js');
  const options = { integrationTarget: target, submissionCommit: f.git('rev-parse', 'main') };
  assert.equal((await worktrees.advanceIntegrationBranch(f.repository, options)).reason, 'already_integrated');
  f.git('worktree', 'remove', f.checkout);
  f.git('worktree', 'add', f.checkout, 'delivery');
  const result = await worktrees.advanceIntegrationBranch(f.repository, options);
  assert.equal(result.reason, 'error');
  assert.match(result.message, /integrationCheckout/);
});

test('integration checkout advancement fast-forwards the selected checkout rather than shared main', async () => {
  const f = fixture();
  const before = f.git('rev-parse', 'HEAD');
  const { ticket, commit } = await submittedFixture(f);
  const composed = path.join(f.repository, '.worktrees/composed');
  f.git('worktree', 'add', '--detach', composed, commit);
  const result = await require('../lib/worktrees.js').advanceIntegrationBranch(f.repository, {
    integrationTarget: ticket.dispatch.integrationTarget, submissionCommit: commit, submissionWorktree: f.repository, admittedScope: ['README.md'],
  });
  assert.equal(result.advanced, true, result.message);
  assert.equal(f.git('-C', f.checkout, 'rev-parse', 'HEAD'), commit);
  assert.equal(f.git('rev-parse', 'HEAD'), before);
});

test('integration checkout survives quota fallback and recovery preparation', () => {
  const f = fixture();
  store.setCategory({ id: 'integration-checkout.fixture', name: 'Integration checkout fixture', route: { model: 'fable', effort: 'high' }, fallback: { model: 'sonnet', effort: 'high' }, enabled: true });
  const prepared = f.prepare();
  const target = prepared.ticket.dispatch.integrationTarget;
  assert.equal(store.recordDispatchLaunch(f.slug, prepared.ticket.ref, { token: prepared.token, executor: prepared.ticket.dispatchExecutor, sessionId: prepared.ticket.dispatch.sessionId }).ok, true);
  const recovered = store.recoverDispatchQuotaFailure(f.slug, prepared.ticket.ref, { token: prepared.token, executor: prepared.ticket.dispatchExecutor, error: "You've reached your Fable limit" });
  assert.equal(recovered.ok, true, recovered.reason);
  assert.deepEqual(recovered.ticket.dispatch.integrationTarget, target);
  assert.equal(recovered.ticket.dispatch.baseCommit, prepared.ticket.dispatch.baseCommit);
  store.setBoardConfig(f.slug, { integrationBranch: 'main' });
  const previous = process.cwd();
  process.chdir(f.repository);
  try {
    const next = store.prepareDispatch(f.slug, prepared.ticket.ref, { sharedTree: true, sessionId: prepared.ticket.dispatch.sessionId });
    assert.equal(next.ok, true, next.message);
    assert.deepEqual(next.ticket.dispatch.integrationTarget, target);
  } finally {
    process.chdir(previous);
  }
});

['implicit', 'branch-only', 'explicit-checkout', 'missing-checkout'].forEach((retry) => test(`integration checkout ordinary redispatch handles ${retry} selection without fallback`, () => {
  const f = fixture();
  const prepared = f.prepare();
  const target = prepared.ticket.dispatch.integrationTarget;
  const owner = `${f.slug}-release`;
  assert.equal(store.recordDispatchLaunch(f.slug, prepared.ticket.ref, { token: prepared.token, executor: prepared.ticket.dispatchExecutor, sessionId: prepared.ticket.dispatch.sessionId }).ok, true);
  assert.equal(store.claimTicket(f.slug, prepared.ticket.ref, owner, { token: prepared.token, executor: prepared.ticket.dispatchExecutor, sessionId: prepared.ticket.dispatch.sessionId }).ok, true);
  assert.equal(store.releaseTicket(f.slug, prepared.ticket.ref, owner, { status: 'todo', source: 'test' }).ok, true);
  assert.deepEqual(store.getTicket(f.slug, prepared.ticket.ref).dispatch.integrationTarget, target);
  store.setBoardConfig(f.slug, { integrationBranch: 'main' });
  const options: Record<string, unknown> = { sharedTree: true, sessionId: prepared.ticket.dispatch.sessionId };
  const other = path.join(f.repository, '.worktrees/other');
  if (retry === 'branch-only') options.integrationBranch = 'main';
  if (retry === 'missing-checkout') f.git('worktree', 'remove', f.checkout);
  if (retry === 'explicit-checkout') {
    f.git('worktree', 'add', '-b', 'other', other, 'main');
    Object.assign(options, { integrationBranch: 'other', integrationCheckout: other });
  }
  const previous = process.cwd();
  process.chdir(f.repository);
  try {
    if (retry === 'branch-only' || retry === 'missing-checkout') {
      assert.throws(() => store.prepareDispatch(f.slug, prepared.ticket.ref, options), /integrationCheckout/);
      assert.deepEqual(store.getTicket(f.slug, prepared.ticket.ref).dispatch.integrationTarget, target);
      return;
    }
    const next = store.prepareDispatch(f.slug, prepared.ticket.ref, options);
    assert.equal(next.ok, true, next.message);
    if (retry === 'explicit-checkout') {
      assert.equal(next.ticket.dispatch.integrationTarget.checkout.path, other);
      assert.equal(next.ticket.dispatch.integrationTarget.branch, 'other');
    } else {
      assert.deepEqual(next.ticket.dispatch.integrationTarget, target);
    }
  } finally {
    process.chdir(previous);
  }
}));

test('integration checkout reservations prevent worker cleanup from reclaiming the target', async () => {
  const f = fixture('agent-former-worker');
  store.setBoardConfig(f.slug, { worktreeDirectory: '.worktrees' });
  const prepared = f.prepare();
  const target = prepared.ticket.dispatch.integrationTarget;
  const pin = target.checkout;
  const terminal = { outcome: 'done', terminalAt: new Date().toISOString(), terminalSource: 'mcp' };
  const oldWorker = { ref: 'SQ-old', status: 'done', dispatch: {
    ...terminal, attempts: [terminal], worktree: pin.path, worktreeBindingSource: 'worktree-create',
    worktreeCreationCompletedAt: terminal.terminalAt, worktreeGitDirectory: pin.gitDirectory,
    worktreeCommonGitDirectory: pin.commonGitDirectory, worktreeCheckoutInstance: pin.checkoutInstance, worktreeObservedRevision: pin.startingRevision,
  } };
  const worktrees = require('../lib/worktrees.js');
  assert.equal(worktrees.isAgentWorktree(f.repository, f.checkout), true);
  const classify = (tickets: any[]) => worktrees.classifyWorktree(f.repository, tickets, { worktree: f.checkout, branch: 'refs/heads/delivery' }, f.repository, 0, 'main', [], 0, [f.repository, f.checkout]);
  assert.equal((await classify([oldWorker])).action, 'remove', 'positive control: a settled worker lease was previously reclaimable');
  assert.equal((await classify([oldWorker, prepared.ticket])).reason, 'integration_target');
  assert.equal(store.recordDispatchLaunch(f.slug, prepared.ticket.ref, { token: prepared.token, executor: prepared.ticket.dispatchExecutor, sessionId: prepared.ticket.dispatch.sessionId, agentName: 'reservation-fixture' }).ok, true);
  assert.equal(store.markDispatchStopped(prepared.ticket.dispatch.sessionId, prepared.ticket.dispatchExecutor, null, 'reservation-fixture').ok, true);
  const ended = store.getTicket(f.slug, prepared.ticket.ref);
  assert.deepEqual(ended.dispatch.attempts.at(-1).integrationTarget, target);
  assert.equal((await classify([oldWorker, { ...ended, dispatch: { attempts: ended.dispatch.attempts } }])).reason, 'integration_target');
});

test('integration checkout pins actual linked identity before dispatch', () => {
  const f = fixture();
  const prepared = f.prepare();
  const target = store.getTicket(f.slug, prepared.ticket.ref).dispatch.integrationTarget;
  assert.ok(target.checkout, 'dispatch must retain the selected checkout');
  assert.equal(target.checkout.path, f.checkout);
  assert.equal(target.checkout.commonGitDirectory, path.join(f.repository, '.git'));
  assert.notEqual(target.checkout.gitDirectory, target.checkout.commonGitDirectory);
  assert.equal(target.checkout.checkoutInstance, kernel.checkoutInstanceIdentity(target.checkout.gitDirectory));
  assert.ok(target.checkout.checkoutInstance);
  assert.equal(target.checkout.startingRevision, f.git('rev-parse', 'delivery'));
  store.setBoardConfig(f.slug, { integrationBranch: 'main' });
  assert.deepEqual(store.ticketIntegrationTarget(f.slug, store.getTicket(f.slug, prepared.ticket.ref)), target);
});

for (const invalid of ['missing', 'shared', 'foreign', 'wrong-branch', 'dirty', 'detached']) {
  test(`integration checkout refuses ${invalid} targets`, () => {
    const f = fixture();
    let checkout = f.checkout;
    if (invalid === 'missing') checkout = path.join(f.repository, 'missing');
    if (invalid === 'shared') checkout = f.repository;
    if (invalid === 'foreign') checkout = fixture().checkout;
    if (invalid === 'wrong-branch') f.git('-C', checkout, 'switch', '-c', 'other');
    if (invalid === 'dirty') fs.writeFileSync(path.join(checkout, 'README.md'), 'operator work\n');
    if (invalid === 'detached') f.git('-C', checkout, 'checkout', '--detach');
    assert.throws(() => f.prepare({ integrationCheckout: checkout }),
      invalid === 'detached' || invalid === 'wrong-branch' ? /must have branch delivery checked out/ : /integrationCheckout/);
  });
}

test('integration checkout supports a local-only branch with an origin remote in auto mode', () => {
  const f = fixture();
  f.git('remote', 'add', 'origin', path.join(f.repository, 'unused-remote'));
  f.git('update-ref', 'refs/remotes/origin/main', f.git('rev-parse', 'main'));
  const prepared = f.prepare();
  assert.equal(prepared.ticket.dispatch.integrationTarget.mode, 'local');
  assert.equal(prepared.ticket.dispatch.integrationTarget.checkout.path, f.checkout);
});

test('branch-only selection retains auto remote-evidence requirements without an integration checkout', () => {
  const f = fixture();
  f.git('remote', 'add', 'origin', path.join(f.repository, 'unused-remote'));
  f.git('update-ref', 'refs/remotes/origin/main', f.git('rev-parse', 'main'));
  assert.throws(() => f.prepare({ integrationCheckout: undefined }), /Configured integration ref.*does not exist/);
});

test('integration checkout explicitly configured remote mode still requires the remote-tracking ref', () => {
  const f = fixture();
  store.setBoardConfig(f.slug, { integrationMode: 'remote' });
  assert.throws(() => f.prepare(), /Configured integration ref.*does not exist/);
  f.git('update-ref', 'refs/remotes/origin/delivery', f.git('rev-parse', 'delivery'));
  const target = f.prepare().ticket.dispatch.integrationTarget;
  assert.equal(target.mode, 'remote');
  assert.equal(target.checkout.path, f.checkout);
});

test('integration checkout is absent from legacy dispatch targets', () => {
  const f = fixture();
  const prepared = f.prepare({ integrationCheckout: undefined });
  assert.deepEqual(prepared.ticket.dispatch.integrationTarget, { mode: 'local', upstream: 'delivery', branch: 'delivery' });
});

test('integration checkout is exposed in the actual MCP dispatch schema', async () => {
  const response = await mcp.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const field = response.result.tools.find((tool: any) => tool.name === 'dispatch').inputSchema.properties.integrationCheckout;
  assert.ok(field, 'callers must be able to select their integration checkout');
  assert.equal(field.type, 'string');
  assert.match(field.description, /linked/);
});
