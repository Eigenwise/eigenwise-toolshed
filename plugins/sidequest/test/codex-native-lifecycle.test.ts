import './_temp-cleanup.js';
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-codex-native-home-'));
const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-codex-native-repo-'));
const discovery = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-codex-native-catalog-'));
fs.mkdirSync(path.join(discovery, 'model-gateway'), { recursive: true });
fs.writeFileSync(path.join(discovery, 'model-gateway', 'catalog.json'), JSON.stringify({
  schemaVersion: 3, updatedAt: new Date().toISOString(), source: 'model-gateway',
  codexReadiness: { ready: true, state: 'ready', message: 'local Codex ready' },
  models: [{ slug: 'codex-gpt-5-6-sol', id: 'claude-gpt-5.6-sol[1m]', label: 'Codex Sol' }],
}));
process.env.SIDEQUEST_HOME = home;
process.env.SIDEQUEST_DISCOVERY_DIRS = discovery;
delete process.env.CLAUDE_CODE_SESSION_ID;
delete process.env.CLAUDE_SESSION_ID;

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}
git(repository, 'init', '-q', '-b', 'main');
git(repository, 'config', 'user.name', 'Native Test');
git(repository, 'config', 'user.email', 'native@example.invalid');
fs.writeFileSync(path.join(repository, 'candidate.txt'), 'initial\n');
git(repository, 'add', 'candidate.txt');
git(repository, 'commit', '-qm', 'initial');

const store = require('../lib/store.js');
const mcp = require('../lib/mcp.js');
const reviewBinding = require('../lib/kernel/review-binding.js');
const worktreeLease = require('../lib/kernel/worktree.js');
const { slug } = store.ensureProject(repository);
store.setCategory({ id: 'codex-native', name: 'Codex native', route: { model: 'codex-gpt-5-6-sol', effort: 'medium' }, enabled: true });
store.setCategory({ id: 'review-audit', name: 'Review audit', route: { model: 'codex-gpt-5-6-sol', effort: 'medium' }, readonly: true, enabled: true });

function tool(name: string) {
  const found = mcp.TOOLS.find((entry: any) => entry.name === name);
  assert.ok(found, name);
  return found;
}

function runtime(thread: string, cwd: string, action: () => any) {
  const before = { session: process.env.CODEX_SESSION_ID, thread: process.env.CODEX_THREAD_ID, cwd: process.cwd() };
  process.env.CODEX_SESSION_ID = 'native-root';
  process.env.CODEX_THREAD_ID = thread;
  process.chdir(cwd);
  try { return action(); } finally {
    process.chdir(before.cwd);
    if (before.session === undefined) delete process.env.CODEX_SESSION_ID; else process.env.CODEX_SESSION_ID = before.session;
    if (before.thread === undefined) delete process.env.CODEX_THREAD_ID; else process.env.CODEX_THREAD_ID = before.thread;
  }
}

function processCall(thread: string, cwd: string, name: string, args: any) {
  const called = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'sidequest-codex-call.js'), name], {
    cwd, env: { ...process.env, CODEX_SESSION_ID: 'native-root', CODEX_THREAD_ID: thread },
    input: JSON.stringify(args), encoding: 'utf8', windowsHide: true,
  });
  assert.equal(called.status, 0, `${called.stderr}\n${called.stdout}`);
  return JSON.parse(called.stdout);
}

function checkout(base: string, label: string) {
  const directory = path.join(home, `worktree-${label}`);
  git(repository, 'worktree', 'add', '--detach', directory, base);
  const gitDir = git(directory, 'rev-parse', '--git-dir');
  worktreeLease.createCheckoutInstanceMarker(path.isAbsolute(gitDir) ? gitDir : path.resolve(directory, gitDir));
  return directory;
}

test('Codex dispatch requires a root identity and a Codex route', () => {
  const ticket = store.createTicket(slug, { title: 'source', category: 'codex-native', files: ['candidate.txt'] });
  assert.throws(() => tool('codex_dispatch').handler({ ref: ticket.ref, project: repository }), /root Codex runtime/);
  const dispatch = processCall('native-root', repository, 'codex_dispatch', { ref: ticket.ref, project: repository });
  assert.equal(dispatch.baseCommit, git(repository, 'rev-parse', 'HEAD'));
  assert.equal(dispatch.sharedTree, false);
  assert.equal(store.getTicket(slug, ticket.ref).dispatch.runtimeHost, 'codex');
  assert.throws(() => runtime('native-root', repository, () => tool('codex_start').handler({ ref: ticket.ref, project: repository, executor: dispatch.executor, tokenFile: dispatch.tokenFile })), /distinct Codex subagent/);
});

test('only the distinct worker with the exact baseline checkout can claim', () => {
  const ticket = store.listTickets(slug).find((row: any) => row.title === 'source');
  const state = ticket.dispatch;
  const worktree = checkout(state.baseCommit, 'source');
  assert.throws(() => runtime('source-thread', worktree, () => tool('codex_start').handler({ ref: ticket.ref, project: repository, executor: state.executor, tokenFile: path.join(home, 'forged') })), /token file and executor/);
  fs.writeFileSync(path.join(worktree, 'candidate.txt'), 'dirty\n');
  const dirty = runtime('source-thread', worktree, () => tool('codex_start').handler({ ref: ticket.ref, project: repository, executor: state.executor, tokenFile: state.tokenFile }));
  assert.equal(dirty.reason, 'worktree_dirty');
  git(worktree, 'checkout', '--', 'candidate.txt');
  const started = processCall('source-thread', worktree, 'codex_start', { ref: ticket.ref, project: repository, executor: state.executor, tokenFile: state.tokenFile });
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.equal(store.getTicket(slug, ticket.ref).dispatch.agentId, 'codex-thread:source-thread');
  assert.equal(store.getTicket(slug, ticket.ref).claim.runtime.agentId, 'codex-thread:source-thread');
  assert.throws(() => runtime('native-root', repository, () => tool('done').handler({ ref: ticket.ref, project: repository, by: 'codex-thread:source-thread', body: 'forged finish' })), /claimed Codex subagent/);
  assert.throws(() => runtime('native-root', repository, () => tool('comment').handler({ ref: ticket.ref, project: repository, by: 'codex-thread:source-thread', body: 'forged worker liveness' })), /claimed Codex subagent/);
});

test('a different Codex agent reviews the exact submitted commit and self-review fails', () => {
  const source = store.listTickets(slug).find((row: any) => row.title === 'source');
  const sourceTree = path.join(home, 'worktree-source');
  fs.writeFileSync(path.join(sourceTree, 'candidate.txt'), 'candidate\n');
  git(sourceTree, 'add', 'candidate.txt');
  git(sourceTree, 'commit', '-qm', 'candidate');
  const candidate = git(sourceTree, 'rev-parse', 'HEAD');
  git(repository, 'update-ref', `refs/sidequest/${source.ref}`, candidate);
  const submission = runtime('source-thread', sourceTree, () => tool('submit').handler({
    ref: source.ref, project: repository, by: 'codex-thread:source-thread',
    commit: candidate, worktree: sourceTree, body: 'Candidate committed and checked.',
  }));
  assert.equal(submission.ok, true, JSON.stringify(submission));
  const review = store.createTicket(slug, {
    title: 'independent review', category: 'review-audit', files: ['candidate.txt'],
  }, { ref: source.ref, commit: candidate });
  const dispatch = runtime('native-root', repository, () => tool('codex_dispatch').handler({ ref: review.ref, project: repository }));
  assert.equal(dispatch.baseCommit, candidate);
  const reviewTree = checkout(candidate, 'review');
  const self = runtime('source-thread', reviewTree, () => tool('codex_start').handler({
    ref: review.ref, project: repository, executor: dispatch.executor, tokenFile: dispatch.tokenFile,
  }));
  assert.equal(self.ok, true, JSON.stringify(self));
  const selfReview = runtime('source-thread', reviewTree, () => tool('done').handler({
    ref: review.ref, project: repository, by: 'codex-thread:source-thread',
    body: 'Self-review should fail.', model: 'codex-gpt-5-6-sol',
  }));
  assert.equal(selfReview.ok, true, JSON.stringify(selfReview));
  assert.equal(reviewBinding.reviewProvenance(store.getTicket(slug, source.ref), store.getTicket(slug, review.ref)).reason, 'shared_agent_identity');
  assert.equal(store.validateIntegrationSubmission(slug, source.ref, {}).reason, 'candidate_review_required');
});

test('separate Codex worker and reviewer satisfy bound provenance', async () => {
  const source = store.createTicket(slug, { title: 'independent source', category: 'codex-native', files: ['candidate.txt'] });
  const dispatch = runtime('native-root', repository, () => tool('codex_dispatch').handler({ ref: source.ref, project: repository }));
  const sourceTree = checkout(dispatch.baseCommit, 'independent-source');
  const started = runtime('worker-two', sourceTree, () => tool('codex_start').handler({
    ref: source.ref, project: repository, executor: dispatch.executor, tokenFile: dispatch.tokenFile,
  }));
  assert.equal(started.ok, true, JSON.stringify(started));
  fs.writeFileSync(path.join(sourceTree, 'candidate.txt'), 'independent candidate\n');
  git(sourceTree, 'add', 'candidate.txt');
  git(sourceTree, 'commit', '-qm', 'independent candidate');
  const candidate = git(sourceTree, 'rev-parse', 'HEAD');
  git(repository, 'update-ref', `refs/sidequest/${source.ref}`, candidate);
  const submitted = runtime('worker-two', sourceTree, () => tool('submit').handler({
    ref: source.ref, project: repository, by: 'codex-thread:worker-two',
    commit: candidate, worktree: sourceTree, body: 'Candidate completed and verified.',
  }));
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  const review = store.createTicket(slug, {
    title: 'separate reviewer', category: 'review-audit', files: ['candidate.txt'],
  }, { ref: source.ref, commit: candidate });
  const reviewDispatch = runtime('native-root', repository, () => tool('codex_dispatch').handler({ ref: review.ref, project: repository }));
  assert.equal(reviewDispatch.baseCommit, candidate);
  const reviewTree = checkout(candidate, 'independent-review');
  const reviewStarted = runtime('reviewer-two', reviewTree, () => tool('codex_start').handler({
    ref: review.ref, project: repository, executor: reviewDispatch.executor, tokenFile: reviewDispatch.tokenFile,
  }));
  assert.equal(reviewStarted.ok, true, JSON.stringify(reviewStarted));
  const reviewed = runtime('reviewer-two', reviewTree, () => tool('done').handler({
    ref: review.ref, project: repository, by: 'codex-thread:reviewer-two',
    body: 'Inspected the exact submitted revision; no issues.', model: 'codex-gpt-5-6-sol',
  }));
  assert.equal(reviewed.ok, true, JSON.stringify(reviewed));
  assert.equal(reviewBinding.reviewProvenance(store.getTicket(slug, source.ref), store.getTicket(slug, review.ref)).reason, 'ok');
  assert.notEqual(store.validateIntegrationSubmission(slug, source.ref, {}).reason, 'candidate_review_required');
  const delivered = await tool('integrate').handler({ project: repository, ref: source.ref, by: 'native-root' });
  assert.equal(delivered.ok, true, JSON.stringify(delivered));
  assert.equal(store.getTicket(slug, source.ref).status, 'done');
});
