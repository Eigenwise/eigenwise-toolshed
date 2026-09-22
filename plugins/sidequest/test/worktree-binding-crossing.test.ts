import './_temp-cleanup.js';
import './_sidequest-install-fixture.js';
'use strict';

// SQ-24. Two dispatches from one session, and the board can end up recording each one against the checkout the
// other executor is running in. The old correction path waited for the sibling to still be unclaimed, so the
// first claim froze the crossing: every completion gate then diffed the other ticket's tree and answered with
// its test names. These cover the three facts that changed - a crossing is still exchangeable after the sibling
// claims, a start callback never re-attributes a checkout a live claim occupies, and the gates name the
// crossing instead of pointing an executor at a tree it cannot use.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { creationGeneration } = require('./_creation-generation.js');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-crossing-home-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;

const store = require('../lib/store.js');
const worktrees = require('../lib/worktrees.js');
const worktreeLease = require('../lib/kernel/worktree.js');
const { crossedWorktreeRefusalMessage } = require('../lib/refusal-guidance.js');

function initRepo(prefix: string) {
  const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Sidequest Test']);
  git(['config', 'user.email', 'sidequest-test@example.invalid']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'crossing fixture\n');
  git(['add', '.']);
  git(['commit', '-m', 'base']);
  return repo;
}

const PROJECT = initRepo('sq-crossing-project-');
const { slug } = store.ensureProject(PROJECT);
const canonical = (worktree: string) => worktreeLease.canonicalPath(worktree);
const boundWorktree = (ref: string) => store.getTicket(slug, ref).dispatch.worktree;

function reserve(sessionId: string, label: string) {
  const ticket = store.createTicket(slug, {
    title: `crossed creation ${label}`,
    category: 'codebase-exploration',
    description: 'One of several dispatches launched from a single orchestrator session.',
    files: ['README.md'],
  });
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId, sharedTree: false });
  const agentName = `sq24-${label}`;
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    sessionId,
    agentName,
  }).ok, true);
  const agentId = `a24${label}`.replace(/[^a-z0-9]/g, '');
  return {
    ref: ticket.ref,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    agentName,
    agentId,
    worktree: worktrees.agentWorktreePath(PROJECT, agentId),
  };
}

// The hook's own sequence: bind the start callback, cut the checkout, then record the completed creation with
// the generation that binding handed out.
function create(sessionId: string, worktree: string) {
  const bound = store.bindDispatchWorktreeCreation(slug, sessionId, worktree);
  assert.equal(bound.ok, true, `start binding refused: ${bound.reason}`);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  execFileSync('git', ['worktree', 'add', '--detach', '--quiet', worktree], { cwd: PROJECT, windowsHide: true });
  const gitDirectoryValue = execFileSync('git', ['rev-parse', '--git-dir'], { cwd: worktree, encoding: 'utf8', windowsHide: true }).trim();
  worktreeLease.createCheckoutInstanceMarker(path.isAbsolute(gitDirectoryValue) ? gitDirectoryValue : path.resolve(worktree, gitDirectoryValue));
  assert.equal(store.completeDispatchWorktreeCreation(slug, sessionId, worktree, creationGeneration(slug, sessionId, worktree)).ok, true);
  return bound;
}

test('a crossed creation order is still exchanged after the sibling claims its ticket', () => {
  const sessionId = 'sq24-claimed-holder';
  const reservations = [reserve(sessionId, 'first'), reserve(sessionId, 'second')];
  // Creation attributes in board order, so the crossing is the arrival order that disagrees with it: the
  // checkout of the reservation the board reads LAST arrives first.
  const order = store.listTickets(slug).map((ticket: any) => ticket.ref);
  const byBoardOrder = reservations.sort((left, right) => order.indexOf(left.ref) - order.indexOf(right.ref));
  const first = byBoardOrder[0]!;
  const second = byBoardOrder[1]!;
  create(sessionId, second.worktree);
  create(sessionId, first.worktree);
  assert.equal(boundWorktree(first.ref), canonical(second.worktree), 'the fixture reproduces the crossing');
  assert.equal(boundWorktree(second.ref), canonical(first.worktree));

  // The sibling's executor claims before anybody's SubagentStart corrects the crossing. A claim names no
  // checkout, so it must not be read as proof that the crossed record is right.
  assert.equal(store.claimTicket(slug, second.ref, 'sq24-second-holder', {
    token: second.token,
    executor: second.executor,
  }).ok, true);

  const bound = store.bindDispatchAgent(sessionId, first.executor, first.agentId, first.agentName, first.worktree);
  assert.equal(bound.ok, true, `a reported checkout must outrank the creation-order guess: ${bound.reason}`);
  assert.equal(boundWorktree(first.ref), canonical(first.worktree), 'the reporting agent keeps the checkout it proved');
  assert.equal(boundWorktree(second.ref), canonical(second.worktree), 'the claimed sibling is handed its own checkout');
  assert.equal(store.getTicket(slug, second.ref).dispatch.worktreeBindingSource, 'worktree-create');
  assert.equal(store.getTicket(slug, second.ref).dispatch.worktreeBindingExchange.with, first.ref);

  // An agent that HAS proven its checkout keeps it: the same exchange is refused once identity is bound.
  const third = reserve(sessionId, 'third');
  create(sessionId, third.worktree);
  const theft = store.bindDispatchAgent(sessionId, third.executor, third.agentId, third.agentName, first.worktree);
  assert.equal(theft.ok, false, 'an identity-bound checkout stays owned');
  assert.equal(boundWorktree(first.ref), canonical(first.worktree));
});

test('a start callback for a checkout a live claim occupies is refused, not re-attributed', () => {
  const sessionId = 'sq24-occupied-checkout';
  // Claimed, and its SubagentStart never bound a runtime identity - the state a frozen crossing leaves behind,
  // and the state in which nothing but the claim says the checkout is occupied.
  const owner = reserve(sessionId, 'owner');
  create(sessionId, owner.worktree);
  assert.equal(store.claimTicket(slug, owner.ref, 'sq24-owner-holder', {
    token: owner.token,
    executor: owner.executor,
  }).ok, true);
  assert.equal(store.getTicket(slug, owner.ref).dispatch.agentId, undefined);

  // A second launch in the same session, and a start callback naming the occupied checkout rather than its own.
  const intruder = reserve(sessionId, 'intruder');
  const refused = store.bindDispatchWorktreeCreation(slug, sessionId, owner.worktree);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'checkout_owned_by_live_claim');
  assert.equal(refused.binding.ownerRef, owner.ref);
  assert.equal(refused.binding.ownerClaimHolder, 'sq24-owner-holder');
  assert.equal(refused.binding.ownerAgentId, '');
  assert.equal(boundWorktree(intruder.ref), undefined, 'the intruding reservation stays unbound');
  assert.equal(boundWorktree(owner.ref), canonical(owner.worktree), 'the live claim keeps its checkout');

  const message = require('../lib/refusal-guidance.js').worktreeCreationRefusalMessage(refused.reason, PROJECT, refused.binding);
  assert.match(message, new RegExp(`${owner.ref} holds this checkout under a live claim`));
  assert.match(message, /nothing was bound/);

  // The one arrival at an occupied checkout the name CAN confirm: its own agent re-entering. Board order puts
  // the intruder's reservation first, so before SQ-24 this is where the occupied checkout was handed over.
  const named = reserve(sessionId, 'named');
  create(sessionId, named.worktree);
  assert.equal(store.bindDispatchAgent(sessionId, named.executor, named.agentId, named.agentName, named.worktree).ok, true);
  assert.equal(store.claimTicket(slug, named.ref, 'sq24-named-holder', {
    token: named.token,
    executor: named.executor,
  }).ok, true);
  const reentry = store.bindDispatchWorktreeCreation(slug, sessionId, named.worktree);
  assert.equal(reentry.ok, true, `the owner's re-entry was refused: ${reentry.reason}`);
  assert.equal(reentry.ref, named.ref);
  assert.equal(reentry.creationCompleted, true);
  assert.equal(boundWorktree(intruder.ref), undefined, 'a re-entry never re-attributes the checkout either');
});

test('a gate whose caller stands in another live claim\'s checkout refuses by naming the crossing', () => {
  const sessionId = 'sq24-gate-message';
  const mine = reserve(sessionId, 'mine');
  const sibling = reserve(sessionId, 'sibling');
  create(sessionId, mine.worktree);
  create(sessionId, sibling.worktree);
  assert.equal(store.bindDispatchAgent(sessionId, sibling.executor, sibling.agentId, sibling.agentName, sibling.worktree).ok, true);
  assert.equal(store.claimTicket(slug, sibling.ref, 'sq24-sibling-holder', {
    token: sibling.token,
    executor: sibling.executor,
  }).ok, true);

  const ticket = store.getTicket(slug, mine.ref);
  assert.equal(store.crossedWorktreeBinding(slug, ticket, mine.worktree), null, 'the bound checkout is no crossing');
  const crossing = store.crossedWorktreeBinding(slug, ticket, sibling.worktree);
  assert.equal(crossing.boundWorktree, canonical(mine.worktree));
  assert.equal(crossing.actualWorktree, canonical(sibling.worktree));
  assert.equal(crossing.actualHolder.ref, sibling.ref);
  assert.equal(crossing.actualHolder.claimHolder, 'sq24-sibling-holder');

  const message = crossedWorktreeRefusalMessage('commit', crossing);
  assert.match(message, new RegExp(`refused ${mine.ref}`));
  assert.match(message, new RegExp(`bound to worktree ${canonical(mine.worktree).replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}`));
  assert.match(message, new RegExp(`${sibling.ref} holds ${canonical(sibling.worktree).replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')} under a live claim`));
  assert.match(message, /crossed worktree binding/);
  assert.match(message, new RegExp(`dispatch ${mine.ref} --worktree`));
  assert.ok(!/Only the bound worktree/.test(message), 'a crossing must not send an executor into an occupied tree');

  // A mismatch with no other live claim behind it is an ordinary relocation, not a crossing.
  const elsewhere = path.join(SIDEQUEST_HOME, 'sq24-elsewhere');
  assert.equal(store.crossedWorktreeBinding(slug, ticket, elsewhere), null);
});
