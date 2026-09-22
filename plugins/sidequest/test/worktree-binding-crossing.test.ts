import './_temp-cleanup.js';
import './_sidequest-install-fixture.js';
'use strict';

// GH-235. Two dispatches from one session, and the board can end up recording each one against the checkout the
// other executor is running in. The old correction path waited for the sibling to still be unclaimed, so the
// first claim froze the crossing: every completion gate then diffed the other ticket's tree and answered with
// its test names. These cover the facts that changed - a crossing is still exchangeable after the sibling
// claims, a start callback never re-attributes a checkout a live claim occupies and never accuses a caller of
// intruding on its own, and commit, submit and the message builder all name a remedy that exists.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { creationGeneration } = require('./_creation-generation.js');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-crossing-home-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;

const store = require('../lib/store.js');
const mcp = require('../lib/mcp.js');
const worktrees = require('../lib/worktrees.js');
const worktreeLease = require('../lib/kernel/worktree.js');
const { crossedWorktreeRefusalMessage, worktreeCreationRefusalMessage } = require('../lib/refusal-guidance.js');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(PLUGIN_ROOT, 'bin', 'sidequest.js');

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
const escaped = (value: string) => value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');

function reserve(sessionId: string, label: string) {
  const ticket = store.createTicket(slug, {
    title: `crossed creation ${label}`,
    category: 'codebase-exploration',
    description: 'One of several dispatches launched from a single orchestrator session.',
    files: ['README.md'],
  });
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId, sharedTree: false });
  const agentName = `crossing-${label}`;
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    sessionId,
    agentName,
  }).ok, true);
  const agentId = `agent${label}`.replace(/[^a-z0-9]/g, '');
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

let requestId = 0;
async function callTool(name: string, args: Record<string, unknown>) {
  const response = await mcp.handleRequest({
    jsonrpc: '2.0',
    id: ++requestId,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  return JSON.parse(response.result.content[0].text);
}

test('a crossed creation order is still exchanged after the sibling claims its ticket', () => {
  const sessionId = 'crossing-claimed-holder';
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
  assert.equal(store.claimTicket(slug, second.ref, 'crossing-second-holder', {
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

// The other half of allowing a claimed holder: when the reporting side created nothing of its own, the move is
// one-sided and the holder's binding is stripped outright while its claim is still live. Leaving that checkout
// recorded against the holder is what froze every retry of the stalled ticket before.
test('a one-sided crossing strips a claimed holder\'s binding instead of freezing it', () => {
  const sessionId = 'crossing-one-sided';
  const stalled = reserve(sessionId, 'stalled');
  const holder = reserve(sessionId, 'holder');
  // Only one WorktreeCreate ever ran, and creation-order attribution gave its checkout to the reservation the
  // board reads first - which is the one whose own hook died.
  const order = store.listTickets(slug).map((ticket: any) => ticket.ref);
  const [taker, reporter] = order.indexOf(stalled.ref) < order.indexOf(holder.ref)
    ? [stalled, holder]
    : [holder, stalled];
  create(sessionId, reporter.worktree);
  assert.equal(boundWorktree(taker.ref), canonical(reporter.worktree));
  assert.equal(boundWorktree(reporter.ref), undefined);
  assert.equal(store.claimTicket(slug, taker.ref, 'crossing-one-sided-holder', {
    token: taker.token,
    executor: taker.executor,
  }).ok, true);

  const reported = store.bindDispatchAgent(sessionId, reporter.executor, reporter.agentId, reporter.agentName, reporter.worktree);
  assert.equal(reported.ok, true, `the one-sided move was refused: ${reported.reason}`);
  assert.equal(boundWorktree(reporter.ref), canonical(reporter.worktree), 'the reporting agent takes the checkout it proved');
  const strippedDispatch = store.getTicket(slug, taker.ref).dispatch;
  assert.equal(strippedDispatch.worktree, null, 'the claimed holder keeps no checkout it never created');
  assert.equal(strippedDispatch.worktreeBindingSource, null);
  assert.equal(strippedDispatch.worktreeBindingExchange.with, reporter.ref);
  assert.equal(strippedDispatch.worktreeBindingExchange.reason, 'creation_order');
  assert.equal(store.getTicket(slug, taker.ref).claim.by, 'crossing-one-sided-holder', 'the claim is untouched');
});

test('a start callback for a checkout a live claim occupies is refused, not re-attributed', () => {
  const sessionId = 'crossing-occupied-checkout';
  // Claimed, and its SubagentStart never bound a runtime identity - the state a frozen crossing leaves behind,
  // and the state in which nothing but the claim says the checkout is occupied.
  const owner = reserve(sessionId, 'owner');
  create(sessionId, owner.worktree);
  assert.equal(store.claimTicket(slug, owner.ref, 'crossing-owner-holder', {
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
  assert.equal(refused.binding.ownerClaimHolder, 'crossing-owner-holder');
  assert.equal(refused.binding.ownerAgentId, '');
  assert.equal(refused.binding.checkoutAgentId, owner.agentId);
  assert.equal(boundWorktree(intruder.ref), undefined, 'the intruding reservation stays unbound');
  assert.equal(boundWorktree(owner.ref), canonical(owner.worktree), 'the live claim keeps its checkout');

  const message = worktreeCreationRefusalMessage(refused.reason, PROJECT, refused.binding);
  assert.match(message, new RegExp(`${owner.ref} holds this checkout under a live claim`));
  assert.match(message, new RegExp(`this creation names agent \`${owner.agentId}\``));
  assert.match(message, /nothing was bound/);

  // The one arrival at an occupied checkout the name CAN confirm: its own agent re-entering. Board order puts
  // the intruder's reservation first, so this is where the occupied checkout used to be handed over.
  const named = reserve(sessionId, 'named');
  create(sessionId, named.worktree);
  assert.equal(store.bindDispatchAgent(sessionId, named.executor, named.agentId, named.agentName, named.worktree).ok, true);
  assert.equal(store.claimTicket(slug, named.ref, 'crossing-named-holder', {
    token: named.token,
    executor: named.executor,
  }).ok, true);
  const reentry = store.bindDispatchWorktreeCreation(slug, sessionId, named.worktree);
  assert.equal(reentry.ok, true, `the owner's re-entry was refused: ${reentry.reason}`);
  assert.equal(reentry.ref, named.ref);
  assert.equal(reentry.creationCompleted, true);
  assert.equal(boundWorktree(intruder.ref), undefined, 'a re-entry never re-attributes the checkout either');
});

// The refusal must not assert something the board never read. WorktreeCreate accepts any single path segment as
// a checkout name, so `agentIdFromWorktreePath` can come back empty, and a live-claim recovery keeps the
// checkout while clearing the agent id. In both states the only record occupying the checkout is the caller's
// own dispatch.
test('an occupied-checkout refusal never accuses a caller of intruding on its own checkout', () => {
  const sessionId = 'crossing-unreadable-name';
  const owner = reserve(sessionId, 'unnamed');
  const unreadable = worktrees.namedWorktreePath(PROJECT, 'review-checkout');
  assert.equal(worktrees.agentIdFromWorktreePath(PROJECT, unreadable), '', 'the fixture name carries no agent id');
  create(sessionId, unreadable);
  assert.equal(store.claimTicket(slug, owner.ref, 'crossing-unnamed-holder', {
    token: owner.token,
    executor: owner.executor,
  }).ok, true);

  // Nothing has bound an identity to it yet, so an arrival is still refused - but the message reports what the
  // checkout name told the board rather than concluding this is not the owner.
  const intruder = reserve(sessionId, 'unnamedintruder');
  const refused = store.bindDispatchWorktreeCreation(slug, sessionId, unreadable);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'checkout_owned_by_live_claim');
  assert.equal(refused.binding.checkoutAgentId, '');
  const message = worktreeCreationRefusalMessage(refused.reason, PROJECT, refused.binding);
  assert.match(message, /the board could not read an agent id from this checkout's name/);
  assert.ok(!/so it is not that owner re-entering/.test(message), 'the board must not assert what it never read');
  assert.equal(boundWorktree(intruder.ref), undefined);

  // Once the owner's agent has proven that exact checkout, its own hook re-entering is admitted against its own
  // record. Skipping it without admitting it would drop the callback into creation-order attribution, which is
  // exactly how an occupied checkout reaches a sibling.
  assert.equal(store.bindDispatchAgent(sessionId, owner.executor, owner.agentId, owner.agentName, unreadable).ok, true);
  const reentry = store.bindDispatchWorktreeCreation(slug, sessionId, unreadable);
  assert.equal(reentry.ok, true, `the owner's re-entry was refused: ${reentry.reason}`);
  assert.equal(reentry.ref, owner.ref);
  assert.equal(boundWorktree(intruder.ref), undefined, 'the sibling reservation never receives the occupied checkout');

  // A live-claim recovery keeps the checkout, clears the agent id and moves the record to the recovering
  // session. The replacement runtime's start callback is the same dispatch coming back, so it is never named as
  // an intruder on its own tree.
  const recoverySession = 'crossing-recovered-session';
  const recovered = store.recoverLiveClaimDispatch(slug, owner.ref, {
    by: 'crossing-unnamed-holder',
    executor: owner.executor,
    worktree: unreadable,
    recoveryEvidence: 'the executor runtime stopped answering while its claim stayed live',
    sessionId: recoverySession,
  });
  assert.equal(recovered.ok, true, `recovery refused: ${recovered.reason}`);
  assert.equal(store.getTicket(slug, owner.ref).dispatch.agentId, null);
  const afterRecovery = store.bindDispatchWorktreeCreation(slug, recoverySession, unreadable);
  assert.notEqual(afterRecovery.reason, 'checkout_owned_by_live_claim', 'the caller\'s own recovered dispatch is not an intruder');
});

test('a gate whose caller stands in another live claim\'s checkout refuses by naming the crossing', () => {
  const sessionId = 'crossing-gate-message';
  const mine = reserve(sessionId, 'mine');
  const sibling = reserve(sessionId, 'sibling');
  create(sessionId, mine.worktree);
  create(sessionId, sibling.worktree);
  assert.equal(store.bindDispatchAgent(sessionId, sibling.executor, sibling.agentId, sibling.agentName, sibling.worktree).ok, true);
  assert.equal(store.claimTicket(slug, sibling.ref, 'crossing-sibling-holder', {
    token: sibling.token,
    executor: sibling.executor,
  }).ok, true);

  const ticket = store.getTicket(slug, mine.ref);
  assert.equal(store.crossedWorktreeBinding(slug, ticket, mine.worktree), null, 'the bound checkout is no crossing');
  const crossing = store.crossedWorktreeBinding(slug, ticket, sibling.worktree);
  assert.equal(crossing.boundWorktree, canonical(mine.worktree));
  assert.equal(crossing.actualWorktree, canonical(sibling.worktree));
  assert.equal(crossing.owner.ref, sibling.ref);
  assert.equal(crossing.owner.claimHolder, 'crossing-sibling-holder');
  assert.equal(crossing.owner.worktree, canonical(sibling.worktree));

  const message = crossedWorktreeRefusalMessage('commit', crossing);
  assert.match(message, new RegExp(`refused ${mine.ref}`));
  assert.match(message, new RegExp(`bound to worktree ${escaped(canonical(mine.worktree))}`));
  assert.match(message, new RegExp(`${sibling.ref} holds ${escaped(canonical(sibling.worktree))} under a live claim`));
  assert.match(message, /crossed worktree binding/);
  assert.ok(!/Only the bound worktree/.test(message), 'a crossing must not send an executor into an occupied tree');
  assert.ok(!/--worktree/.test(message), 'dispatch takes no worktree flag, so the remedy must not print one');

  // A mismatch with no other live claim behind it is an ordinary relocation, not a crossing.
  const elsewhere = path.join(SIDEQUEST_HOME, 'crossing-elsewhere');
  assert.equal(store.crossedWorktreeBinding(slug, ticket, elsewhere), null);
});

// The remedy an agent reads is the part that has to be real. The previous wording printed
// `sidequest dispatch <ref> --worktree <path>`, which `assertCommandFlags` rejects outright, so this runs the
// exact command the refusal prints and requires it to release the crossed claim for real.
test('the remedy a crossing refusal prints is a command the CLI runs', async () => {
  const sessionId = 'crossing-printed-remedy';
  const mine = reserve(sessionId, 'remedy');
  const sibling = reserve(sessionId, 'remedysibling');
  create(sessionId, mine.worktree);
  create(sessionId, sibling.worktree);
  assert.equal(store.bindDispatchAgent(sessionId, sibling.executor, sibling.agentId, sibling.agentName, sibling.worktree).ok, true);
  assert.equal(store.claimTicket(slug, sibling.ref, 'crossing-remedy-sibling', {
    token: sibling.token,
    executor: sibling.executor,
  }).ok, true);
  assert.equal(store.bindDispatchAgent(sessionId, mine.executor, mine.agentId, mine.agentName, mine.worktree).ok, true);
  assert.equal(store.claimTicket(slug, mine.ref, 'crossing-remedy-holder', {
    token: mine.token,
    executor: mine.executor,
  }).ok, true);

  // The gate wiring itself, not just the builder: commit checks unconditionally, submit only when the caller
  // supplied the worktree it ran from.
  const committed = await callTool('commit', {
    project: PROJECT,
    ref: mine.ref,
    by: 'crossing-remedy-holder',
    message: 'work done in the sibling\'s checkout',
    worktree: sibling.worktree,
  });
  assert.equal(committed.ok, false);
  assert.equal(committed.reason, 'crossed_worktree_binding');
  assert.match(committed.message, new RegExp(`^commit: refused ${mine.ref};`));
  const submitted = await callTool('submit', {
    project: PROJECT,
    ref: mine.ref,
    by: 'crossing-remedy-holder',
    commit: 'a'.repeat(40),
    worktree: sibling.worktree,
    verify: 'npm test',
    body: 'A final report long enough for the submission gate to accept it as a report rather than a stub sentence.',
  });
  assert.equal(submitted.ok, false);
  assert.equal(submitted.reason, 'crossed_worktree_binding');
  assert.match(submitted.message, new RegExp(`^submit: refused ${mine.ref};`));

  // `sidequest release <ref> --release-kind technical_blocker --reason "..."`, taken out of the printed message
  // rather than retyped, and run against this fixture's board.
  const printed = /`(sidequest release [^`]+)`/.exec(committed.message);
  assert.ok(printed, `the refusal prints no runnable remedy: ${committed.message}`);
  const evidence = `commit ${mine.ref} --worktree ${sibling.worktree}`;
  const argv = printed![1]!.match(/"[^"]*"|\S+/g)!.slice(1)
    .map((token) => token.replace(/^"|"$/g, ''))
    .map((token) => (/^<.+>$/.test(token) ? evidence : token));
  const released = spawnSync(process.execPath, [CLI, ...argv, '--by', 'crossing-remedy-holder', '--project', PROJECT], {
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
      CLAUDE_PROJECT_DIR: PROJECT,
      SIDEQUEST_HOME,
    },
  });
  assert.ok(!/unknown or unsupported flag/.test(released.stderr), `the printed remedy names a flag the CLI rejects: ${released.stderr}`);
  assert.equal(released.status, 0, released.stderr);
  assert.equal(store.getTicket(slug, mine.ref).claim, undefined, 'the printed remedy releases the crossed claim');
  assert.equal(store.getTicket(slug, sibling.ref).claim.by, 'crossing-remedy-sibling', 'the other live claim is untouched');
});
