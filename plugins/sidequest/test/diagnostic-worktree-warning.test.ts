import './_temp-cleanup.js';
import './_sidequest-install-fixture.js';
'use strict';
/**
 * What a receiving agent is told about worktrees that are not its own (SQ-1957).
 *
 * Claude Code keys its LSP diagnostics registry per session, so an executor's
 * errors land in the orchestrator's context and no setting or hook can stop
 * them. The only lever left is the advice attached to them, and the advice is
 * only correct if it comes from the lease the board holds: the same directory is
 * expected noise while a claim is live, dead weight once the run ended, and
 * worth reading before an integration when it holds a candidate.
 *
 * Run: npm run test:files -- "test/diagnostic-worktree-warning.test.ts"
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-diagnostic-warning-home-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;

const store = require('../lib/store.js');
const db = require('../lib/db.js');
const worktrees = require('../lib/worktrees.js');
const { diagnosticWorktreeWarning } = require('../hooks/diagnostic-worktree-warning.js');

const HOUR = 60 * 60 * 1000;

const codingNormal = store.getCategory('coding.normal');
store.setCategory(Object.assign({}, codingNormal, { route: { model: 'sonnet', effort: 'medium' }, fallback: null }));

function git(repository: string, args: string[]) {
  return execFileSync('git', args, { cwd: repository, encoding: 'utf8', windowsHide: true }).trim();
}

function board(label: string) {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), `sq-diagnostic-${label}-`));
  git(repository, ['init', '-b', 'main']);
  git(repository, ['config', 'user.name', 'Sidequest Test']);
  git(repository, ['config', 'user.email', 'sidequest-test@example.invalid']);
  fs.writeFileSync(path.join(repository, 'candidate.txt'), 'candidate\n');
  git(repository, ['add', 'candidate.txt']);
  git(repository, ['commit', '-m', 'candidate']);
  const { slug } = store.ensureProject(repository);
  return { repository, slug, commit: git(repository, ['rev-parse', 'HEAD']) };
}

function persist(slug: string, ticket: any) {
  db.putRow(db.openDb(SIDEQUEST_HOME), 'tickets', {
    id: ticket.id,
    project: slug,
    ref: ticket.ref,
    status: ticket.status,
    archived: ticket.archived ? 1 : 0,
    ord: ticket.order,
    claim_by: ticket.claim ? ticket.claim.by : null,
    data: ticket,
  });
}

// A real isolated dispatch carrying a real claim, because the point of the test is that the lease decides, and a
// hand-written claim would decide nothing. The directory is left uncreated so each caller chooses whether this
// worktree exists on disk.
function claimedIsolatedDispatch(slug: string, repository: string, title: string, label: string) {
  const ticket = store.createTicket(slug, {
    title,
    description: 'Where: diagnostic warning fixture. Contract: hold one isolated dispatch. Verify: inspect persisted board state.',
    category: 'coding.normal',
    files: ['candidate.txt'],
    source: 'cli',
  });
  const sessionId = `diagnostic-${label}`;
  const agentId = `diagnostic-agent-${label}`;
  const prepared = store.prepareDispatch(slug, ticket.ref, { sharedTree: false, sessionId });
  const token = prepared.token;
  const executor = prepared.ticket.dispatchExecutor;
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, { token, executor, sessionId, agentName: agentId }).ok, true);
  const worktree = worktrees.agentWorktreePath(repository, agentId);
  assert.equal(store.bindDispatchWorktreeCreation(slug, sessionId, worktree).ok, true);
  assert.equal(store.bindDispatchAgent(sessionId, executor, agentId, agentId).ok, true);
  assert.equal(store.claimTicket(slug, ticket.ref, agentId, { token, executor, sessionId }).ok, true);
  return { ref: ticket.ref, worktree, sessionId, agentId, token, executor };
}

// A terminal submission parked for integration, exactly as a submitted executor leaves it. The candidate commit
// is deliberately off the integration branch, because the board reads a candidate already reachable from main as
// shipped and refuses to retire it.
function submittedCandidate(slug: string, repository: string, label: string) {
  git(repository, ['checkout', '-b', `candidate-${label}`]);
  fs.writeFileSync(path.join(repository, 'candidate.txt'), `candidate ${label}\n`);
  git(repository, ['commit', '-am', `candidate ${label}`]);
  const commit = git(repository, ['rev-parse', 'HEAD']);
  git(repository, ['checkout', 'main']);
  const dispatch = claimedIsolatedDispatch(slug, repository, `candidate ${label}`, label);
  const ticket = store.getTicket(slug, dispatch.ref);
  const terminalAt = new Date().toISOString();
  ticket.claim = null;
  ticket.dispatch = Object.assign({}, ticket.dispatch, { terminalAt, outcome: 'submitted' });
  ticket.submission = {
    by: dispatch.agentId,
    at: terminalAt,
    commit,
    verify: 'manual: fixture',
    changedPaths: ['candidate.txt'],
    integratedAt: null,
  };
  persist(slug, ticket);
  return dispatch;
}

test('the same worktree is expected noise while its claim is live and dead weight once the run ended', () => {
  const { repository, slug } = board('lease');
  const live = claimedIsolatedDispatch(slug, repository, 'live isolated executor', 'live');
  fs.mkdirSync(live.worktree, { recursive: true });

  const held = diagnosticWorktreeWarning({ cwd: repository });
  assert.match(held, /keyed per session, not per agent/);
  assert.match(held, new RegExp(`1 holds a live claim \\(${live.ref}\\)`), 'a live lease makes the errors expected');
  assert.match(held, /never outrank that executor's own verify/);
  assert.doesNotMatch(held, /Actionable exception/, 'nothing has been handed in yet');
  assert.doesNotMatch(held, /gone from disk/);

  assert.equal(store.recordDispatchAgentFailure(slug, live.ref, {
    token: live.token,
    executor: live.executor,
    sessionId: live.sessionId,
    taskName: live.agentId,
    agentId: live.agentId,
    agentName: live.agentId,
    error: 'Prompt is too long',
  }).ok, true);

  const ended = diagnosticWorktreeWarning({ cwd: repository });
  assert.match(ended, /1 foreign agent worktree in play/, 'the directory is still there and still leaking');
  assert.doesNotMatch(ended, /live claim/, 'the same path stops being live work the moment the lease ends');
  assert.match(ended, /Keep error-severity diagnostics in your own files actionable\./);
});

test('a dead claim over a vanished worktree is named as false, without waiting for a terminal stamp', () => {
  const { repository, slug } = board('swept');
  const swept = claimedIsolatedDispatch(slug, repository, 'swept isolated executor', 'swept');
  assert.equal(store.getTicket(slug, swept.ref).dispatch.terminalAt, null, 'nothing observed this executor stop');
  assert.equal(fs.existsSync(swept.worktree), false);
  assert.equal(store.claimReleaseVerdict(store.getTicket(slug, swept.ref)).kind, 'missing_worktree');

  const warning = diagnosticWorktreeWarning({ cwd: repository });
  assert.match(warning, /1 of those paths is already gone from disk/);
  assert.match(warning, /a diagnostic naming a path that no longer exists is always false/);
  assert.doesNotMatch(warning, /live claim/, 'a claim the board calls reclaimable is not live work');

  // Pushes for a removed worktree keep arriving for minutes, not hours, so the record stops being worth a line.
  assert.equal(diagnosticWorktreeWarning({ cwd: repository }, Date.now() + 3 * HOUR), '');
});

test('a candidate awaiting integration is the one actionable exception', () => {
  const { repository, slug } = board('candidate');
  const candidate = submittedCandidate(slug, repository, 'candidate');
  fs.mkdirSync(candidate.worktree, { recursive: true });

  const warning = diagnosticWorktreeWarning({ cwd: repository });
  assert.match(warning, new RegExp(`Actionable exception: ${candidate.ref} holds a candidate awaiting integration`));
  assert.match(warning, /outweighs an executor's `verify passed`/);
  assert.doesNotMatch(warning, /live claim/, 'the executor handed in and left');

  const retired = store.recordAbandonedSubmission(slug, candidate.ref, {
    reason: 'The fixture retires the candidate without landing it.',
    target: { branch: 'main' },
  });
  assert.equal(retired.ok, true, retired.message);
  assert.doesNotMatch(diagnosticWorktreeWarning({ cwd: repository }), /Actionable exception/, 'a retired candidate has nothing left to read');
});

test('sidequest\'s own worktree root is covered, and the receiving agent\'s checkout never is', () => {
  const { repository, slug } = board('roots');
  const [ownRoot, harnessRoot] = worktrees.agentWorktreeRoots(repository);
  const receiver = path.join(ownRoot, 'agent-receiver');
  fs.mkdirSync(receiver, { recursive: true });
  fs.writeFileSync(path.join(receiver, '.git'), `gitdir: ${path.join(repository, '.git', 'worktrees', 'agent-receiver')}\n`);
  assert.equal(diagnosticWorktreeWarning({ cwd: receiver }), '', 'the receiving agent is never warned about itself');

  // Sidequest provisions outside the project and Claude Code's own isolation provisions inside it. The warning
  // covered only the second root until SQ-1957, so a board-less directory under the first one has to count.
  fs.mkdirSync(path.join(ownRoot, 'agent-foreign'), { recursive: true });
  fs.mkdirSync(path.join(harnessRoot, 'agent-harness'), { recursive: true });
  const warning = diagnosticWorktreeWarning({ cwd: receiver });
  assert.match(warning, /2 foreign agent worktrees in play/);
  assert.ok(warning.includes(`Nothing under ${ownRoot} or ${harnessRoot} is yours.`), 'both roots are named');
  assert.equal(store.listTickets(slug).length, 0, 'neither directory is on the board, and both still leak');
});
