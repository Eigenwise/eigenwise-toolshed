import './_temp-cleanup.js';
import './_sidequest-install-fixture.js';
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
  schemaVersion: 3, updatedAt: new Date(Date.now() - 11 * 24 * 60 * 60 * 1000).toISOString(), source: 'model-gateway',
  codexReadiness: { ready: false, state: 'unavailable', message: 'gateway shim unavailable' },
  models: [{ slug: 'codex-gpt-5-6-sol', id: 'claude-gpt-5.6-sol[1m]', label: 'Codex Sol via gateway' }],
}));
const nativeCatalogFile = path.join(home, 'native-codex-models.json');
function writeNativeCatalog(verifiedAt = new Date().toISOString()) {
  fs.writeFileSync(nativeCatalogFile, JSON.stringify({
    schemaVersion: 1, verifiedAt, attestedBy: 'native lifecycle test fixture',
    models: [{ slug: 'native-codex-gpt-5-6-sol', id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: ['medium'] }],
  }));
}
writeNativeCatalog();
process.env.SIDEQUEST_HOME = home;
process.env.SIDEQUEST_DISCOVERY_DIRS = discovery;
delete process.env.CLAUDE_CODE_SESSION_ID;
delete process.env.CLAUDE_SESSION_ID;
// The fixture supplies its own root/worker identities; a Codex-hosted test
// runner must not become the implicit root for calls outside runtime().
delete process.env.CODEX_SESSION_ID;
delete process.env.CODEX_THREAD_ID;

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
const db = require('../lib/db.js');
const reviewBinding = require('../lib/kernel/review-binding.js');
const worktreeLease = require('../lib/kernel/worktree.js');

// store.js exposes no public putTicket; fixtures that need to write a ticket
// state directly (a claim-free terminal submission that never ran through the
// dispatch/claim/submit tools) persist through the same db row shape store.js
// itself writes (see store.ts ticketStorageRow), matching review-binding.test.ts.
function persist(projectSlug: string, ticket: any) {
  db.putRow(db.openDb(home), 'tickets', {
    id: ticket.id,
    project: projectSlug,
    ref: ticket.ref,
    status: ticket.status,
    archived: ticket.archived ? 1 : 0,
    ord: ticket.order,
    claim_by: ticket.claim ? ticket.claim.by : null,
    data: ticket,
  });
}
const { slug } = store.ensureProject(repository);
store.setCategory({ id: 'codex-native', name: 'Codex native', route: { model: 'native-codex-gpt-5-6-sol', effort: 'medium' }, enabled: true });
store.setCategory({ id: 'review-audit', name: 'Review audit', route: { model: 'native-codex-gpt-5-6-sol', effort: 'medium' }, readonly: true, enabled: true });
store.setCategory({ id: 'claude-mixed-source', name: 'Claude mixed source', route: { model: 'sonnet', effort: 'medium' }, readonly: true, enabled: true });

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

function claudeRuntime(session: string, cwd: string, action: () => any) {
  const names = ['CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID'];
  const before = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const beforeCwd = process.cwd();
  process.env.CLAUDE_CODE_SESSION_ID = session;
  delete process.env.CLAUDE_SESSION_ID;
  delete process.env.CODEX_SESSION_ID;
  delete process.env.CODEX_THREAD_ID;
  process.chdir(cwd);
  try { return action(); } finally {
    process.chdir(beforeCwd);
    for (const name of names) {
      if (before[name] === undefined) delete process.env[name];
      else process.env[name] = before[name];
    }
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

function prepareBoundNativeReview(label: string, sameRuntime = false) {
  const sourceThread = `source-${label}`;
  const reviewerThread = sameRuntime ? sourceThread : `reviewer-${label}`;
  const source = store.createTicket(slug, { title: `native source ${label}`, category: 'codex-native', files: ['candidate.txt'] });
  const sourceDispatch = runtime('native-root', repository, () => tool('codex_dispatch').handler({ ref: source.ref, project: repository }));
  const sourceTree = checkout(sourceDispatch.baseCommit, `${label}-source`);
  const sourceStart = runtime(sourceThread, sourceTree, () => tool('codex_start').handler({
    ref: source.ref, project: repository, executor: sourceDispatch.executor, tokenFile: sourceDispatch.tokenFile,
  }));
  assert.equal(sourceStart.ok, true, JSON.stringify(sourceStart));
  fs.writeFileSync(path.join(sourceTree, 'candidate.txt'), `candidate ${label}\n`);
  git(sourceTree, 'add', 'candidate.txt');
  git(sourceTree, 'commit', '-qm', `candidate ${label}`);
  const candidate = git(sourceTree, 'rev-parse', 'HEAD');
  git(repository, 'update-ref', `refs/sidequest/${source.ref}`, candidate);
  const submitted = runtime(sourceThread, sourceTree, () => tool('submit').handler({
    ref: source.ref,
    project: repository,
    by: `codex-thread:${sourceThread}`,
    commit: candidate,
    worktree: sourceTree,
    body: `Candidate ${candidate} committed and verified.`,
  }));
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  const review = store.createTicket(slug, {
    title: `native review ${label}`, category: 'review-audit', files: ['candidate.txt'],
  }, { ref: source.ref, commit: candidate });
  const reviewDispatch = runtime('native-root', repository, () => tool('codex_dispatch').handler({ ref: review.ref, project: repository }));
  assert.equal(reviewDispatch.baseCommit, candidate);
  const reviewTree = checkout(candidate, `${label}-review`);
  const reviewStart = runtime(reviewerThread, reviewTree, () => tool('codex_start').handler({
    ref: review.ref, project: repository, executor: reviewDispatch.executor, tokenFile: reviewDispatch.tokenFile,
  }));
  assert.equal(reviewStart.ok, true, JSON.stringify(reviewStart));
  return { source, candidate, review, reviewTree, reviewerThread };
}

// A Claude submitter (dispatch.runtimeHost never set to 'codex') bound to a
// native Codex reviewer: the live SQ-90/SQ-92 case. The source half is built
// directly as a claim-free terminal submission (the same pattern review-binding
// tests use) since only the reviewer's runtime is meant to gate native closeout.
function prepareMixedReview(label: string) {
  const sourceThread = `claude-source-${label}`;
  const reviewerThread = `reviewer-${label}`;
  const base = git(repository, 'rev-parse', 'HEAD');
  const sourceTree = checkout(base, `${label}-mixed-source`);
  fs.writeFileSync(path.join(sourceTree, 'candidate.txt'), `mixed candidate ${label}\n`);
  git(sourceTree, 'add', 'candidate.txt');
  git(sourceTree, 'commit', '-qm', `mixed candidate ${label}`);
  const candidate = git(sourceTree, 'rev-parse', 'HEAD');
  const created = store.createTicket(slug, { title: `mixed source ${label}`, category: 'claude-mixed-source', files: ['candidate.txt'] });
  // prepareBoundNativeReview preserves its candidate at refs/sidequest/<ref> so
  // validateIntegrationSubmission's scope/reachability checks have a frozen ref
  // to resolve; this claim-free fixture needs the same ref or integration-path
  // assertions (e.g. ok:true after review_outcome accepted) fail on an
  // unrelated "no frozen ref" refusal instead of exercising the review gate.
  const gitRef = `refs/sidequest/${created.ref}`;
  git(repository, 'update-ref', gitRef, candidate);
  const terminalAt = new Date().toISOString();
  const source = store.getTicket(slug, created.id);
  source.status = 'doing';
  source.claim = null;
  source.dispatch = {
    terminalAt,
    outcome: 'submitted',
    agentId: `claude-agent-${sourceThread}`,
    attempts: [{ outcome: 'submitted', commit: candidate, agentId: `claude-agent-${sourceThread}`, terminalAt }],
  };
  // Mirrors the range metadata the real submit tool derives from git for
  // prepareBoundNativeReview's candidate, so validateIntegrationSubmission's
  // scope/reachability check (unrelated to the review gate under test) can
  // reach ok:true instead of refusing on missing_git_ref.
  source.submission = {
    by: `claude-thread:${sourceThread}`,
    at: terminalAt,
    commit: candidate,
    gitRef,
    verify: 'manual: mixed fixture candidate verified',
    base,
    upstream: 'main',
    upstreamCommit: base,
    commits: [candidate],
    changedPaths: ['candidate.txt'],
    admittedScope: ['candidate.txt'],
    integrationMode: 'local',
    integrationBranch: 'main',
    integratedAt: null,
  };
  persist(slug, source);
  const review = store.createTicket(slug, {
    title: `mixed review ${label}`, category: 'review-audit', files: ['candidate.txt'],
  }, { ref: created.ref, commit: candidate });
  const reviewDispatch = runtime('native-root', repository, () => tool('codex_dispatch').handler({ ref: review.ref, project: repository }));
  assert.equal(reviewDispatch.baseCommit, candidate);
  const reviewTree = checkout(candidate, `${label}-mixed-review`);
  const reviewStart = runtime(reviewerThread, reviewTree, () => tool('codex_start').handler({
    ref: review.ref, project: repository, executor: reviewDispatch.executor, tokenFile: reviewDispatch.tokenFile,
  }));
  assert.equal(reviewStart.ok, true, JSON.stringify(reviewStart));
  return { source: store.getTicket(slug, created.ref), candidate, review, reviewTree, reviewerThread };
}

function nativeReviewComment(fixture: any, body: string) {
  return runtime(fixture.reviewerThread, fixture.reviewTree, () => tool('comment').handler({
    ref: fixture.review.ref,
    project: repository,
    by: `codex-thread:${fixture.reviewerThread}`,
    body,
  }));
}

function finishNativeReview(fixture: any, body: string) {
  return runtime(fixture.reviewerThread, fixture.reviewTree, () => tool('done').handler({
    ref: fixture.review.ref,
    project: repository,
    by: `codex-thread:${fixture.reviewerThread}`,
    model: 'native-codex-gpt-5-6-sol',
    effort: 'medium',
    body,
  }));
}

function recordNativeReviewOutcome(fixture: any, extra: any = {}) {
  return runtime('native-root', repository, () => tool('review_outcome').handler({
    ref: fixture.review.ref,
    project: repository,
    ...extra,
  }));
}

test('Codex dispatch requires a root identity and a Codex route', () => {
  const ticket = store.createTicket(slug, { title: 'source', category: 'codex-native', files: ['candidate.txt'] });
  assert.equal(store.getTicket(slug, ticket.ref)?.category?.id, 'codex-native');
  assert.equal(store.getTicket(slug, ticket.ref).category.route.model, 'native-codex-gpt-5-6-sol');
  assert.ok(store.getModelVocab().models.includes('native-codex-gpt-5-6-sol'));
  const storedTicket = store.getTicket(slug, ticket.ref);
  assert.equal(store.resolveTicketRoute(storedTicket, storedTicket.category).exec?.source, 'codex-native');
  assert.equal(store.claimTicket(slug, ticket.ref, 'codex-thread:foreign-thread', { direct: true,
    reason: 'This is a small change and context is already loaded.' }).reason, 'codex_start_required');
  assert.throws(() => runtime('foreign-thread', repository, () => tool('claim').handler({
    ref: ticket.ref, project: repository, by: 'codex-thread:foreign-thread', direct: true,
    reason: 'This is a small change and context is already loaded.',
  })), /codex_start/);
  const mcpNext = runtime('foreign-thread', repository, () => tool('next').handler({
    project: repository, by: 'codex-thread:foreign-thread', category: 'codex-native', direct: true,
    reason: 'This is a small change and context is already loaded.',
  }));
  assert.equal(mcpNext.ok, false);
  assert.equal(store.getTicket(slug, ticket.ref).claim, null);
  assert.throws(() => runtime('native-root', repository, () => tool('done').handler({
    ref: ticket.ref, project: repository, by: 'codex-thread:foreign-thread', body: 'forged finish',
  })), /claimed Codex subagent/);
  const cliNext = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'sidequest.js'),
    'next', '--project', repository, '--category', 'codex-native', '--direct',
    '--reason', 'This is a small change and context is already loaded.', '--json'], {
    cwd: repository, env: { ...process.env, CODEX_SESSION_ID: 'native-root', CODEX_THREAD_ID: 'foreign-thread' },
    encoding: 'utf8', windowsHide: true,
  });
  assert.equal(cliNext.status, 1, cliNext.stderr);
  assert.equal(store.getTicket(slug, ticket.ref).claim, null);
  assert.throws(() => tool('codex_dispatch').handler({ ref: ticket.ref, project: repository }), /root Codex runtime/);
  const dispatch = processCall('native-root', repository, 'codex_dispatch', { ref: ticket.ref, project: repository });
  assert.equal(store.resolveTicketRoute(storedTicket, storedTicket.category).exec?.source, 'codex-native');
  assert.equal(store.resolveTicketRoute({ ref: 'SQ-gateway' }, {
    id: 'gateway', route: { model: 'codex-gpt-5-6-sol', effort: 'medium' },
  }).exec, null);
  assert.equal(dispatch.baseCommit, git(repository, 'rev-parse', 'HEAD'));
  assert.equal(dispatch.sharedTree, false);
  assert.equal(store.getTicket(slug, ticket.ref).dispatch.runtimeHost, 'codex');
  const otherWorkerRead = processCall('unassigned-worker', repository, 'list', { ref: ticket.ref, project: repository });
  const ordinaryRead = JSON.stringify(otherWorkerRead);
  assert.equal(ordinaryRead.includes(store.getTicket(slug, ticket.ref).dispatchNonce), false);
  assert.equal(ordinaryRead.includes(dispatch.tokenFile), false);
  assert.equal(ordinaryRead.includes('"tokenFile"'), false);
  assert.equal(ordinaryRead.includes('"dispatchNonce"'), false);
  const cliList = JSON.stringify(store.listPayload(slug, { all: true }));
  assert.equal(cliList.includes(dispatch.tokenFile), false);
  assert.equal(cliList.includes(store.getTicket(slug, ticket.ref).dispatchNonce), false);
  assert.throws(() => runtime('native-root', repository, () => tool('codex_start').handler({ ref: ticket.ref, project: repository, executor: dispatch.executor, tokenFile: dispatch.tokenFile })), /distinct Codex subagent/);
});

test('native model admission expires independently of the gateway catalog', () => {
  writeNativeCatalog(new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString());
  try {
    const ticket = store.createTicket(slug, { title: 'expired native route', category: 'codex-native', files: ['candidate.txt'] });
    assert.throws(() => runtime('native-root', repository, () => tool('codex_dispatch').handler({ ref: ticket.ref, project: repository })), /available native Codex route/);
    assert.equal(store.getTicket(slug, ticket.ref).dispatchNonce, null);
  } finally { writeNativeCatalog(); }
});

test('native redispatch retires a reduced Claude attempt and claims on the pinned native route', async () => {
  const categoryId = 'reduced-claude-native-retry';
  store.setCategory({
    id: categoryId, name: 'Reduced Claude to native Codex',
    route: { model: 'sonnet', effort: 'medium' }, readonly: true, enabled: true,
  });
  const ticket = store.createTicket(slug, {
    title: 'reduced Claude to native Codex retry',
    description: 'Where: inspect the temporary repository in an isolated checkout.\n\n'
      + 'Contract: exercise a reduced-schema Claude dispatch that bound but did not claim, then move the category to its native Codex route. '
      + 'The retry must preserve the native route and clear Claude-only runtime requirements.\n\n'
      + 'Verify: the former attempt remains protected during claim grace, then the host-evidenced retry claims and closes on its pinned route.',
    executorVerify: 'git diff --check',
    category: categoryId, files: ['candidate.txt'],
  });
  claudeRuntime('claude-reduced-root', repository, () => tool('dispatch').handler({
    ref: ticket.ref, project: repository, reducedAgentSchema: true,
  }));
  const first = store.getTicket(slug, ticket.ref);
  assert.equal(first.dispatch.route.model, 'sonnet');
  assert.equal(first.dispatch.reducedAgentSchema, true);
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    token: first.dispatchNonce, executor: first.dispatch.executor,
    sessionId: first.dispatch.sessionId, agentName: first.dispatch.launchName,
  }).ok, true);
  assert.equal(store.bindDispatchAgent(
    first.dispatch.sessionId, first.dispatch.executor, 'claude-reduced-agent', first.dispatch.launchName,
  ).ok, true);
  assert.ok(store.getTicket(slug, ticket.ref).dispatch.boundAt);

  store.setCategory({
    id: categoryId, name: 'Reduced Claude to native Codex',
    route: { model: 'native-codex-gpt-5-6-sol', effort: 'medium' }, readonly: true, enabled: true,
  });
  const recoveryEvidence = 'Host confirmed the prior Claude agent terminated without claiming the ticket.';
  const graceNames = ['SIDEQUEST_CLAIM_GRACE_MIN', 'SIDEQUEST_CLAIM_IDLE_MIN'];
  const priorGrace = Object.fromEntries(graceNames.map((name) => [name, process.env[name]]));
  process.env.SIDEQUEST_CLAIM_GRACE_MIN = '0.001';
  process.env.SIDEQUEST_CLAIM_IDLE_MIN = '0.002';
  let dispatch: any;
  try {
    assert.throws(() => runtime('native-root', repository, () => tool('codex_dispatch').handler({
      ref: ticket.ref, project: repository, recoveryEvidence,
    })), /cannot be superseded on recovery evidence/);
    assert.equal(store.getTicket(slug, ticket.ref).dispatch.terminalAt, null, 'evidence cannot bypass claim grace');
    await new Promise((resolve) => setTimeout(resolve, 90));
    dispatch = runtime('native-root', repository, () => tool('codex_dispatch').handler({
      ref: ticket.ref, project: repository, recoveryEvidence,
    }));
  } finally {
    for (const name of graceNames) {
      if (priorGrace[name] === undefined) delete process.env[name];
      else process.env[name] = priorGrace[name];
    }
  }

  assert.equal(tool('codex_dispatch').inputSchema.properties.recoveryEvidence.type, 'string');
  assert.equal(dispatch.model, 'native-codex-gpt-5-6-sol');
  assert.equal(dispatch.effort, 'medium');
  const prepared = store.getTicket(slug, ticket.ref);
  assert.equal(prepared.dispatch.route.model, 'native-codex-gpt-5-6-sol');
  assert.equal(prepared.dispatch.reducedAgentSchema, undefined);
  assert.equal(prepared.dispatch.runtimeHost, 'codex');
  assert.equal(prepared.dispatch.attempts.at(-1).failureShape, 'stranded_bound_launch_superseded');
  assert.equal(prepared.dispatch.attempts.at(-1).recoveryEvidence, recoveryEvidence);

  const worktree = checkout(dispatch.baseCommit, 'reduced-claude-native-retry');
  const started = processCall('native-retry-worker', worktree, 'codex_start', {
    ref: ticket.ref, project: repository, executor: dispatch.executor, tokenFile: dispatch.tokenFile,
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  const finished = runtime('native-retry-worker', worktree, () => tool('done').handler({
    ref: ticket.ref, project: repository, by: 'codex-thread:native-retry-worker',
    body: 'Completed the native retry on its pinned route.', model: 'native-codex-gpt-5-6-sol', effort: 'medium',
  }));
  assert.equal(finished.ok, true, JSON.stringify(finished));
  const terminal = store.getTicket(slug, ticket.ref);
  assert.equal(terminal.status, 'done');
  assert.equal(terminal.dispatch.outcome, 'done');
  assert.ok(terminal.dispatch.terminalAt);
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
  for (const thread of ['native-root', 'foreign-thread']) {
    assert.throws(() => runtime(thread, worktree, () => tool('scopeRequest').handler({
      ref: ticket.ref, project: repository, by: 'codex-thread:source-thread', files: ['candidate.txt'],
    })), /claimed Codex subagent/);
  }
  const ownScope = runtime('source-thread', worktree, () => tool('scopeRequest').handler({
    ref: ticket.ref, project: repository, by: 'codex-thread:source-thread', files: ['candidate.txt'],
  }));
  assert.equal(ownScope.ok, true, JSON.stringify(ownScope));
  for (const thread of ['native-root', 'foreign-thread']) {
    for (const action of [
      ['claim', ticket.ref, '--by', 'codex-thread:source-thread'],
      ['checkpoint', ticket.ref, '--by', 'codex-thread:source-thread', '--commit', 'abcdef0', '--verify', 'passed'],
      ['release', ticket.ref, '--by', 'codex-thread:source-thread'],
      ['done', ticket.ref, '--by', 'codex-thread:source-thread', '--body', 'Forged completion'],
      ['commit', ticket.ref, '--by', 'codex-thread:source-thread', '--message', 'forged commit'],
      ['submit', ticket.ref, '--by', 'codex-thread:source-thread', '--commit', 'abcdef0'],
      ['submit', ticket.ref, '--by', 'codex-thread:source-thread', '--clear'],
      ['scope-request', ticket.ref, '--by', 'codex-thread:source-thread', '--file', 'other.txt'],
      ['comment', ticket.ref, '--by', 'codex-thread:source-thread', '--body', 'Forged worker evidence'],
    ]) {
      const denied = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'sidequest.js'),
        ...action, '--project', repository], {
        cwd: repository, env: { ...process.env, CODEX_SESSION_ID: 'native-root', CODEX_THREAD_ID: thread },
        encoding: 'utf8', windowsHide: true,
      });
      assert.equal(denied.status, 1, `${action[0]}: ${denied.stdout}\n${denied.stderr}`);
      assert.match(denied.stderr + denied.stdout, /per-agent Sidequest MCP process/i);
    }
  }
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
  for (const thread of ['native-root', 'foreign-thread']) {
    assert.throws(() => runtime(thread, repository, () => tool('rework').handler({
      ref: source.ref, project: repository, by: 'codex-thread:source-thread',
      review: 'SQ-fake', reason: 'Forged candidate rejection.',
    })), /submitting Codex subagent/);
  }
  const review = store.createTicket(slug, {
    title: 'independent review', category: 'review-audit', files: ['candidate.txt'],
  }, { ref: source.ref, commit: candidate });
  assert.throws(() => runtime('source-thread', sourceTree, () => tool('submit').handler({
    ref: source.ref, project: repository, by: 'codex-thread:source-thread', clear: true,
  })), /root orchestration thread/);
  const lockedClear = runtime('native-root', repository, () => tool('submit').handler({
    ref: source.ref, project: repository, by: 'codex-thread:source-thread', clear: true,
  }));
  assert.equal(lockedClear.ok, false);
  const dispatch = runtime('native-root', repository, () => tool('codex_dispatch').handler({ ref: review.ref, project: repository }));
  assert.equal(dispatch.baseCommit, candidate);
  const reviewTree = checkout(candidate, 'review');
  const self = runtime('source-thread', reviewTree, () => tool('codex_start').handler({
    ref: review.ref, project: repository, executor: dispatch.executor, tokenFile: dispatch.tokenFile,
  }));
  assert.equal(self.ok, true, JSON.stringify(self));
  const selfReview = runtime('source-thread', reviewTree, () => tool('done').handler({
    ref: review.ref, project: repository, by: 'codex-thread:source-thread',
    body: 'Self-review should fail.', model: 'native-codex-gpt-5-6-sol',
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
  const passComment = runtime('reviewer-two', reviewTree, () => tool('comment').handler({
    ref: review.ref, project: repository, by: 'codex-thread:reviewer-two',
    body: [
      'PASS: The exact submitted candidate satisfies the review contract.',
      `CHECK: pinned candidate verification | PASS | The declared checks passed at ${candidate}.`,
    ].join('\n'),
  }));
  assert.equal(passComment.ok, true, JSON.stringify(passComment));
  assert.throws(() => runtime('reviewer-two', reviewTree, () => tool('done').handler({
    ref: review.ref, project: repository, by: 'codex-thread:reviewer-two',
    body: 'Incorrect model stamp.', model: 'sonnet',
  })), /pinned route model/);
  const reviewed = runtime('reviewer-two', reviewTree, () => tool('done').handler({
    ref: review.ref, project: repository, by: 'codex-thread:reviewer-two',
    body: 'Inspected the exact submitted revision; no issues.', model: 'native-codex-gpt-5-6-sol',
  }));
  assert.equal(reviewed.ok, true, JSON.stringify(reviewed));
  assert.equal(reviewBinding.reviewProvenance(store.getTicket(slug, source.ref), store.getTicket(slug, review.ref)).reason, 'ok');
  // A PASS comment plus done alone leaves the outcome planned; review_outcome
  // must record the authenticated acceptance before integration is admitted.
  assert.equal(store.validateIntegrationSubmission(slug, source.ref, {}).reason, 'candidate_review_required');
  const recorded = runtime('native-root', repository, () => tool('review_outcome').handler({ ref: review.ref, project: repository }));
  assert.equal(recorded.ok, true, JSON.stringify(recorded));
  assert.equal(recorded.reviewOutcome, 'accepted');
  assert.notEqual(store.validateIntegrationSubmission(slug, source.ref, {}).reason, 'candidate_review_required');
  const delivered = await tool('integrate').handler({ project: repository, ref: source.ref, by: 'native-root' });
  assert.equal(delivered.ok, true, JSON.stringify(delivered));
  assert.equal(store.getTicket(slug, source.ref).status, 'done');
});

test('review_outcome derives a terminal FIX result and keeps rejection and supersession guards', async () => {
  const fixture = prepareBoundNativeReview('record-rejection');
  assert.equal(tool('review_outcome').inputSchema.properties.outcome, undefined, 'the caller cannot choose the review outcome');
  const comment = nativeReviewComment(fixture, [
    'FIX: The submitted completion path omits the durable bound-review outcome.',
    'FINDING: The source mirror remains planned after the reviewer closed the exact candidate.',
    'EVIDENCE: The terminal review left the source binding planned for this exact candidate.',
    'REQUIRED: Record the authenticated terminal review result on both binding halves.',
  ].join('\n'));
  assert.equal(comment.ok, true, JSON.stringify(comment));
  const done = finishNativeReview(fixture, 'Reviewed the pinned submitted candidate and recorded the finding above.');
  assert.equal(done.ok, true, JSON.stringify(done));

  const before = store.validateIntegrationSubmission(slug, fixture.source.ref, {});
  assert.equal(before.reason, 'candidate_review_required', 'a terminal rejection marker blocks integration before it is materialized');
  const recorded = recordNativeReviewOutcome(fixture, { outcome: 'accepted' });
  assert.equal(recorded.ok, true, JSON.stringify(recorded));
  assert.equal(recorded.reviewOutcome, 'rejected', 'caller-supplied outcome is ignored');
  assert.equal(recorded.evidence.schema, 'sidequest.bound-review.v1');
  assert.equal(recorded.evidence.candidate.value, fixture.candidate);
  assert.equal(recorded.evidence.decisionCommentId, comment.commentId);
  assert.equal(recorded.evidence.reviewer.agentId, `codex-thread:${fixture.reviewerThread}`);
  assert.deepEqual(recorded.evidence.findings, [{
    description: 'The source mirror remains planned after the reviewer closed the exact candidate.',
    evidence: 'The terminal review left the source binding planned for this exact candidate.',
    requiredChange: 'Record the authenticated terminal review result on both binding halves.',
  }]);
  assert.equal(store.getTicket(slug, fixture.review.ref).reviewTarget.outcome, 'rejected');
  assert.equal(store.getTicket(slug, fixture.source.ref).submission.review.outcome, 'rejected');

  const repeated = recordNativeReviewOutcome(fixture, { outcome: 'accepted' });
  assert.equal(repeated.ok, true);
  assert.equal(repeated.idempotent, true);
  assert.equal(repeated.reviewOutcome, 'rejected');
  assert.equal(store.validateIntegrationSubmission(slug, fixture.source.ref, {}).reason, 'candidate_rejected');
  assert.equal(store.reworkSubmission(slug, fixture.source.ref, {
    by: `codex-thread:${fixture.reviewerThread}`, review: 'The authenticated review found a defect.', reason: 'Repair the missing durable outcome.',
  }).reason, 'candidate_review_locked');

  const repair = store.createTicket(slug, { title: 'not yet integrated repair', category: 'codex-native', files: ['candidate.txt'] });
  const superseded = await tool('supersede_submission').handler({
    project: repository, ref: fixture.source.ref, by: 'native-root', supersededBy: repair.ref,
    reason: 'The replacement is not integrated yet.',
  });
  assert.equal(superseded.ok, false, 'recording rejection alone does not satisfy guarded supersession');
  assert.equal(store.getTicket(slug, fixture.source.ref).submission.commit, fixture.candidate);
});

test('review_outcome rejects a bare FIX marker without structured rejection evidence', () => {
  const fixture = prepareBoundNativeReview('bare-fix-evidence');
  assert.equal(nativeReviewComment(fixture, 'FIX: Looks bad').ok, true);
  assert.equal(finishNativeReview(fixture, 'Reviewed the exact submitted candidate.').ok, true);

  const result = recordNativeReviewOutcome(fixture);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'review_evidence_invalid');
  assert.equal(store.getTicket(slug, fixture.source.ref).submission.review.outcome, 'planned');
});

test('review_outcome requires a named failing CHECK to use its evidence', () => {
  const fixture = prepareBoundNativeReview('unnamed-failing-check');
  assert.equal(nativeReviewComment(fixture, [
    'FIX: The submitted candidate needs a repair.',
    'FINDING: The source binding lacks a recorded terminal outcome.',
    'CHECK: | FAIL | The review record remains planned for this candidate.',
    'REQUIRED: Record the authenticated terminal review result.',
  ].join('\n')).ok, true);
  assert.equal(finishNativeReview(fixture, 'Reviewed the exact submitted candidate.').ok, true);

  const result = recordNativeReviewOutcome(fixture);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'review_evidence_invalid');
  assert.equal(store.getTicket(slug, fixture.source.ref).submission.review.outcome, 'planned');
});

test('review_outcome records structured PASS evidence on both binding halves', () => {
  const fixture = prepareBoundNativeReview('record-acceptance');
  const comment = nativeReviewComment(fixture, [
    'PASS: The exact submitted candidate satisfies the review contract.',
    `CHECK: pinned candidate verification | PASS | The declared checks passed at ${fixture.candidate}.`,
  ].join('\n'));
  assert.equal(comment.ok, true, JSON.stringify(comment));
  assert.equal(finishNativeReview(fixture, 'Reviewed the exact submitted candidate.').ok, true);

  const beforeRecord = store.validateIntegrationSubmission(slug, fixture.source.ref, {});
  assert.equal(beforeRecord.reason, 'candidate_review_required', 'a PASS comment plus done alone leaves outcome planned; it must not integrate before review_outcome records acceptance');
  assert.equal(store.getTicket(slug, fixture.review.ref).reviewTarget.outcome, undefined);
  assert.equal(store.getTicket(slug, fixture.source.ref).submission.review.outcome, 'planned');

  const recorded = recordNativeReviewOutcome(fixture);
  assert.equal(recorded.ok, true, JSON.stringify(recorded));
  assert.equal(recorded.reviewOutcome, 'accepted');
  assert.equal(store.getTicket(slug, fixture.review.ref).reviewTarget.outcome, 'accepted');
  assert.equal(store.getTicket(slug, fixture.source.ref).submission.review.outcome, 'accepted');
  assert.notEqual(store.validateIntegrationSubmission(slug, fixture.source.ref, {}).reason, 'candidate_review_required');
});

test('a millisecond tick inside done still records and integrates a native PASS review', async () => {
  const fixture = prepareBoundNativeReview('clock-tick-done');
  const comment = nativeReviewComment(fixture, [
    'PASS: The exact submitted candidate satisfies the review contract.',
    `CHECK: pinned candidate verification | PASS | The declared checks passed at ${fixture.candidate}.`,
  ].join('\n'));
  assert.equal(comment.ok, true, JSON.stringify(comment));
  // Force every zero-arg `new Date()` to advance >=1 ms so a second clock read
  // during done would split completion.at from the attempt's terminalAt.
  const RealDate = Date;
  let last = RealDate.now();
  class TickDate extends RealDate {
    constructor(...args: any[]) {
      if (args.length === 0) { last = Math.max(last + 1, RealDate.now()); super(last); }
      else super(...(args as [any]));
    }
    static now() { return RealDate.now(); }
  }
  (globalThis as any).Date = TickDate;
  let finished: any;
  try {
    finished = finishNativeReview(fixture, 'Reviewed the exact submitted candidate.');
  } finally {
    (globalThis as any).Date = RealDate;
  }
  assert.equal(finished.ok, true, JSON.stringify(finished));
  const reviewTicket = store.getTicket(slug, fixture.review.ref);
  const attempts = reviewTicket.dispatch.attempts;
  assert.equal(reviewTicket.completion.at, attempts[attempts.length - 1].terminalAt, 'completion and terminal attempt share one clock read');
  const recorded = recordNativeReviewOutcome(fixture);
  assert.equal(recorded.ok, true, JSON.stringify(recorded));
  assert.equal(recorded.reviewOutcome, 'accepted');
  const delivered = await tool('integrate').handler({ project: repository, ref: fixture.source.ref, by: 'native-root' });
  assert.equal(delivered.ok, true, JSON.stringify(delivered));
  assert.equal(store.getTicket(slug, fixture.source.ref).status, 'done');
});

test('a mirror-only accepted outcome does not integrate without a matching reviewTarget outcome', () => {
  const fixture = prepareBoundNativeReview('mirror-only-accepted');
  const comment = nativeReviewComment(fixture, [
    'PASS: The exact submitted candidate satisfies the review contract.',
    `CHECK: pinned candidate verification | PASS | The declared checks passed at ${fixture.candidate}.`,
  ].join('\n'));
  assert.equal(comment.ok, true, JSON.stringify(comment));
  assert.equal(finishNativeReview(fixture, 'Reviewed the exact submitted candidate.').ok, true);

  // Hand-craft a half-applied recording, as if the transaction that writes
  // both binding halves together had been interrupted or hand-edited: only
  // the source ticket's mirror is marked accepted, and the review ticket's
  // own reviewTarget half is left untouched at `planned`.
  const halfRecordedSource = store.getTicket(slug, fixture.source.ref);
  halfRecordedSource.submission = Object.assign({}, halfRecordedSource.submission, {
    review: Object.assign({}, halfRecordedSource.submission.review, { outcome: 'accepted' }),
  });
  persist(slug, halfRecordedSource);

  assert.equal(store.getTicket(slug, fixture.review.ref).reviewTarget.outcome, undefined, 'fixture sanity: the reviewTarget half was never recorded');
  const relation = reviewBinding.reviewRelationFor(
    store.getTicket(slug, fixture.source.ref),
    store.listTickets(slug),
    (idOrRef: string) => store.getTicket(slug, idOrRef),
  );
  assert.equal(reviewBinding.reviewRelationOutcome(relation), 'accepted', 'fixture sanity: the generic OR-based helper alone already reads this as accepted');

  const blocked = store.validateIntegrationSubmission(slug, fixture.source.ref, {});
  assert.equal(blocked.reason, 'candidate_review_required', 'a mirror-only accepted outcome must not integrate; the reviewTarget half still needs review_outcome');
});

test('review_outcome refuses a nonterminal FAIL comment and a forged reviewer author', () => {
  const fixture = prepareBoundNativeReview('nonterminal-fail');
  const comment = nativeReviewComment(fixture, [
    'FAIL: The candidate omits the required binding outcome.',
    'EVIDENCE: The review is still active and its candidate mirror remains planned.',
    'REQUIRED: Finish the review on this candidate before recording its result.',
  ].join('\n'));
  assert.equal(comment.ok, true, JSON.stringify(comment));
  assert.throws(() => runtime('native-root', repository, () => tool('comment').handler({
    ref: fixture.review.ref,
    project: repository,
    by: `codex-thread:${fixture.reviewerThread}`,
    body: 'FIX: forged reviewer evidence with a caller-selected author.',
  })), /claimed Codex subagent/);
  const refused = recordNativeReviewOutcome(fixture);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'review_not_terminal');
  assert.equal(store.getTicket(slug, fixture.source.ref).submission.review.outcome, 'planned');
  assert.equal(store.validateIntegrationSubmission(slug, fixture.source.ref, {}).reason, 'candidate_review_required');
});

test('validateIntegrationSubmission blocks a native review after a bare done with no PASS or FAIL evidence', () => {
  const fixture = prepareBoundNativeReview('bare-native-done');
  assert.equal(finishNativeReview(fixture, 'Reviewed the exact submitted candidate.').ok, true);

  const blocked = store.validateIntegrationSubmission(slug, fixture.source.ref, {});
  assert.equal(blocked.reason, 'candidate_review_required', 'a native reviewer\'s bare done with no PASS/FIX/FAIL evidence must not integrate');
  assert.equal(store.getTicket(slug, fixture.review.ref).reviewTarget.outcome, undefined);
  assert.equal(store.getTicket(slug, fixture.source.ref).submission.review.outcome, 'planned');
  assert.doesNotMatch(blocked.message, /\.\./, 'the review-evidence sentence and the appended guidance sentence must not collide into a double period');

  const result = recordNativeReviewOutcome(fixture);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'review_evidence_missing');
  assert.equal(store.getTicket(slug, fixture.source.ref).submission.review.outcome, 'planned');
});

test('validateIntegrationSubmission blocks a native review whose terminal attempt lost its identity binding', () => {
  const fixture = prepareBoundNativeReview('identity-missing');
  assert.equal(finishNativeReview(fixture, 'Reviewed the exact submitted candidate.').ok, true);

  // Corrupt the terminal attempt's immutable identity snapshot directly (a
  // hand-edited or half-migrated record), leaving the review ticket's own
  // status and completion.state terminally done. This isolates the fail-open
  // gap nativeTerminalReviewEvidence's own identity check has to catch, from
  // terminalReviewFailure's separate top-level "review is not done at all"
  // guard, which this scenario does not trip.
  const review = store.getTicket(slug, fixture.review.ref);
  const attempts = review.dispatch.attempts.slice();
  attempts[attempts.length - 1] = Object.assign({}, attempts[attempts.length - 1], { sessionId: null });
  review.dispatch = Object.assign({}, review.dispatch, { attempts });
  persist(slug, review);

  const blocked = store.validateIntegrationSubmission(slug, fixture.source.ref, {});
  assert.equal(blocked.reason, 'candidate_review_required', 'a terminal review with no identified reviewer runtime must not integrate');
  assert.match(blocked.message, /has no terminal done attempt tied to its authenticated Codex reviewer runtime/);

  const result = recordNativeReviewOutcome(fixture);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'terminal_reviewer_identity_missing');
});

test('a Claude submitter bound to a native Codex reviewer still requires review_outcome to record acceptance', () => {
  const fixture = prepareMixedReview('mixed-accept');
  assert.notEqual(store.getTicket(slug, fixture.source.ref).dispatch?.runtimeHost, 'codex', 'fixture sanity: the submitter runtime is not native Codex');
  assert.equal(store.getTicket(slug, fixture.review.ref).dispatch?.runtimeHost, 'codex', 'fixture sanity: the reviewer runtime is native Codex');

  const comment = nativeReviewComment(fixture, [
    'PASS: The exact submitted candidate satisfies the review contract.',
    `CHECK: pinned candidate verification | PASS | The declared checks passed at ${fixture.candidate}.`,
  ].join('\n'));
  assert.equal(comment.ok, true, JSON.stringify(comment));
  assert.equal(finishNativeReview(fixture, 'Reviewed the exact submitted candidate.').ok, true);

  const beforeRecord = store.validateIntegrationSubmission(slug, fixture.source.ref, {});
  assert.equal(beforeRecord.reason, 'candidate_review_required', 'closeout is keyed to the reviewer being native Codex, regardless of the submitter runtime');

  const recorded = recordNativeReviewOutcome(fixture);
  assert.equal(recorded.ok, true, JSON.stringify(recorded));
  assert.equal(recorded.reviewOutcome, 'accepted');
  assert.equal(store.getTicket(slug, fixture.review.ref).reviewTarget.outcome, 'accepted');
  assert.equal(store.getTicket(slug, fixture.source.ref).submission.review.outcome, 'accepted');
  const v = store.validateIntegrationSubmission(slug, fixture.source.ref, {});
  assert.equal(v.ok, true, JSON.stringify(v));
});

test('a Claude submitter bound to a native Codex reviewer stays blocked behind a bare done with no evidence', () => {
  const fixture = prepareMixedReview('mixed-bare-done');
  assert.equal(finishNativeReview(fixture, 'Reviewed the exact submitted candidate.').ok, true);

  const blocked = store.validateIntegrationSubmission(slug, fixture.source.ref, {});
  assert.equal(blocked.reason, 'candidate_review_required', 'a native reviewer\'s bare done with no PASS/FIX/FAIL evidence must not integrate a Claude-submitted candidate either');
  assert.equal(store.getTicket(slug, fixture.review.ref).reviewTarget.outcome, undefined);
  assert.equal(store.getTicket(slug, fixture.source.ref).submission.review.outcome, 'planned');

  const result = recordNativeReviewOutcome(fixture);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'review_evidence_missing');
});

test('a Claude submitter bound to a native Codex reviewer stays blocked behind an authenticated FIX until it is recorded', () => {
  const fixture = prepareMixedReview('mixed-fix-unrecorded');
  const comment = nativeReviewComment(fixture, [
    'FIX: The submitted completion path omits the durable bound-review outcome.',
    'FINDING: The source mirror remains planned after the reviewer closed the exact candidate.',
    'EVIDENCE: The terminal review left the source binding planned for this exact candidate.',
    'REQUIRED: Record the authenticated terminal review result on both binding halves.',
  ].join('\n'));
  assert.equal(comment.ok, true, JSON.stringify(comment));
  assert.equal(finishNativeReview(fixture, 'Reviewed the exact submitted candidate.').ok, true);

  const blocked = store.validateIntegrationSubmission(slug, fixture.source.ref, {});
  assert.equal(blocked.reason, 'candidate_review_required', 'an authenticated FIX/FAIL outcome still blocks integration until review_outcome records it, regardless of the submitter runtime');
  assert.equal(store.getTicket(slug, fixture.source.ref).submission.review.outcome, 'planned');
});

test('a Claude submitter bound to a native Codex reviewer is permanently blocked once review_outcome records rejection', () => {
  const fixture = prepareMixedReview('mixed-rejected');
  const comment = nativeReviewComment(fixture, [
    'FIX: The submitted completion path omits the durable bound-review outcome.',
    'FINDING: The source mirror remains planned after the reviewer closed the exact candidate.',
    'EVIDENCE: The terminal review left the source binding planned for this exact candidate.',
    'REQUIRED: Record the authenticated terminal review result on both binding halves.',
  ].join('\n'));
  assert.equal(comment.ok, true, JSON.stringify(comment));
  assert.equal(finishNativeReview(fixture, 'Reviewed the exact submitted candidate.').ok, true);

  const recorded = recordNativeReviewOutcome(fixture);
  assert.equal(recorded.ok, true, JSON.stringify(recorded));
  assert.equal(recorded.reviewOutcome, 'rejected');
  assert.equal(store.getTicket(slug, fixture.review.ref).reviewTarget.outcome, 'rejected');
  assert.equal(store.getTicket(slug, fixture.source.ref).submission.review.outcome, 'rejected');

  const after = store.validateIntegrationSubmission(slug, fixture.source.ref, {});
  assert.equal(after.reason, 'candidate_rejected');
});

test('review_outcome rejects untrusted, malformed, and self-review evidence', () => {
  const forged = prepareBoundNativeReview('untrusted-review-comment');
  assert.equal(finishNativeReview(forged, 'The review completed without a structured result.').ok, true);
  const fakeComment = runtime('native-root', repository, () => tool('comment').handler({
    ref: forged.review.ref,
    project: repository,
    by: 'native-root',
    body: 'FIX: An orchestrator cannot forge this finding after the review ended.',
  }));
  assert.equal(fakeComment.ok, true);
  const missing = recordNativeReviewOutcome(forged);
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'review_evidence_missing');
  assert.equal(store.getTicket(slug, forged.source.ref).submission.review.outcome, 'planned');

  const malformed = prepareBoundNativeReview('malformed-review-evidence');
  assert.equal(nativeReviewComment(malformed, 'PASS: Looks good.').ok, true);
  assert.equal(finishNativeReview(malformed, 'Review completed without check evidence.').ok, true);
  const invalid = recordNativeReviewOutcome(malformed);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, 'review_evidence_invalid');
  assert.equal(store.validateIntegrationSubmission(slug, malformed.source.ref, {}).reason, 'candidate_review_required');

  const self = prepareBoundNativeReview('self-review-outcome', true);
  assert.equal(nativeReviewComment(self, [
    'FIX: The source and reviewer are the same runtime.',
    'FINDING: The immutable terminal attempts share one Codex agent id.',
    'EVIDENCE: The immutable terminal attempts share one Codex agent id.',
    'REQUIRED: Use an independent reviewer runtime.',
  ].join('\n')).ok, true);
  assert.equal(finishNativeReview(self, 'Self-review completed.').ok, true);
  const selfResult = recordNativeReviewOutcome(self);
  assert.equal(selfResult.ok, false);
  assert.equal(selfResult.reason, 'shared_agent_identity');
  assert.equal(store.getTicket(slug, self.source.ref).submission.review.outcome, 'planned');
});

test('HTTP and CLI ticket reads hide a reviewer capability while dispatch returns it', async () => {
  const story = store.createStory(slug, { title: 'Reviewer capability boundary' });
  const review = store.createTicket(slug, {
    title: 'review with sealed token', category: 'review-audit', storyId: story.ref, files: ['candidate.txt'],
  });
  const dispatch = runtime('native-root', repository, () => tool('codex_dispatch').handler({ ref: review.ref, project: repository }));
  const token = store.getTicket(slug, review.ref).dispatchNonce;
  assert.equal(fs.readFileSync(dispatch.tokenFile, 'utf8').trim(), token);
  for (const suffix of [[], ['--json']]) {
    const denied = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'sidequest.js'),
      'claim', review.ref, '--project', repository, '--by', 'unassigned-worker', '--direct',
      '--reason', 'This is a small change and context is already loaded.', ...suffix], {
      cwd: repository, env: { ...process.env, CODEX_SESSION_ID: 'native-root', CODEX_THREAD_ID: 'unassigned-worker' },
      encoding: 'utf8', windowsHide: true,
    });
    assert.equal(denied.status, 1, denied.stderr);
    const refusal = denied.stdout + denied.stderr;
    assert.match(refusal, /per-agent Sidequest MCP process/i);
    assert.equal(refusal.includes(dispatch.tokenFile), false);
    assert.equal(refusal.includes(token), false);
    if (suffix.length) assert.equal(denied.stdout, '');
  }
  const server = await require('../lib/server.js').start(0);
  try {
    const listResponse = await fetch(`${server.url}/api/tickets?project=${encodeURIComponent(slug)}`);
    const listBody = await listResponse.text();
    assert.equal(listResponse.status, 200);
    assert.equal(JSON.parse(listBody).tickets.some((ticket: any) => ticket.ref === review.ref), true);
    assert.equal(listBody.includes(token), false);
    assert.equal(listBody.includes(dispatch.tokenFile), false);
    assert.equal(listBody.includes('"tokenFile"'), false);
    const patchResponse = await fetch(`${server.url}/api/tickets/${review.ref}?project=${encodeURIComponent(slug)}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ labels: ['audited'] }),
    });
    const patchBody = await patchResponse.text();
    assert.equal(patchResponse.status, 200, patchBody);
    assert.equal(patchBody.includes(token), false);
    assert.equal(patchBody.includes(dispatch.tokenFile), false);
    assert.equal(patchBody.includes('"tokenFile"'), false);
  } finally { await new Promise((resolve) => server.server.close(resolve)); }
  const shown = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'sidequest.js'),
    'story', 'show', story.ref, '--project', repository, '--json'], {
    cwd: repository, env: { ...process.env, CODEX_SESSION_ID: 'native-root', CODEX_THREAD_ID: 'other-worker' },
    encoding: 'utf8', windowsHide: true,
  });
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(JSON.parse(shown.stdout).tickets.some((ticket: any) => ticket.ref === review.ref), true);
  assert.equal(shown.stdout.includes(token), false);
  assert.equal(shown.stdout.includes(dispatch.tokenFile), false);
  assert.equal(shown.stdout.includes('"tokenFile"'), false);
  const updated = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'sidequest.js'),
    'update', review.ref, '--project', repository, '--label', 'audited', '--json'], {
    cwd: repository, env: { ...process.env, CODEX_SESSION_ID: 'native-root', CODEX_THREAD_ID: 'other-worker' },
    encoding: 'utf8', windowsHide: true,
  });
  assert.equal(updated.status, 0, updated.stderr);
  assert.equal(JSON.parse(updated.stdout).ticket.ref, review.ref);
  assert.equal(updated.stdout.includes(token), false);
  assert.equal(updated.stdout.includes(dispatch.tokenFile), false);
});
