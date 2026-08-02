import './_temp-cleanup.js';
import './_sidequest-install-fixture.js';
'use strict';

// SQ-826. An executor dispatched with worktree isolation paused for a scope
// request before its first edit, and the harness discarded the unchanged
// worktree when it stopped. The resume put it back in the SHARED checkout with
// no warning, and it wrote nine files onto main believing it was isolated.
// These cover the refusals that now make that loud.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-isolation-home-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;

const store = require('../lib/store.js');
const agentsync = require('../lib/agentsync.js');

const HOOKS = path.join(__dirname, '..', 'hooks');
const GUARD_ISOLATION = path.join(HOOKS, 'guard-worktree-isolation.js');
const GUARD_DESTRUCTIVE = path.join(HOOKS, 'guard-destructive-git.js');

function initRepo(prefix: string) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
  git(['init']);
  git(['config', 'user.name', 'Sidequest Test']);
  git(['config', 'user.email', 'sidequest-test@example.invalid']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'isolation fixture\n');
  git(['add', '.']);
  git(['commit', '-m', 'base']);
  return repo;
}

const PROJECT = initRepo('sq-isolation-project-');
const { slug } = store.ensureProject(PROJECT);
const exploration = store.getCategory('codebase-exploration');
store.setCategory(Object.assign({}, exploration, { route: { model: 'sonnet', effort: 'medium' }, fallback: null }));

function runHook(script: string, payload: unknown) {
  const out = execFileSync(process.execPath, [script], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, SIDEQUEST_HOME },
    windowsHide: true,
  });
  return out.trim() ? JSON.parse(out) : null;
}

function runCli(args: string[]) {
  return execFileSync(process.execPath, [path.join(__dirname, '..', 'bin', 'sidequest.js'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, SIDEQUEST_HOME },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function dispatched(agentId: string, options: { sharedTree?: boolean } = {}) {
  const ticket = store.createTicket(slug, {
    title: `isolation fixture ${agentId}`,
    category: 'codebase-exploration',
    description: 'A fixture dispatch that records whether isolation was promised.',
    files: ['README.md'],
  });
  const sessionId = `session-${agentId}`;
  const prepared = store.prepareDispatch(slug, ticket.ref, {
    sharedTree: options.sharedTree === true,
    sessionId,
  });
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    sessionId,
    agentName: agentId,
  }).ok, true);
  assert.equal(store.bindDispatchAgent(sessionId, prepared.ticket.dispatchExecutor, agentId, agentId).ok, true);
  const bound = store.getTicket(slug, ticket.ref);
  return { ticket: bound, sessionId, executor: bound.dispatchExecutor };
}

function writePayload(agentId: string, executor: string, sessionId: string, filePath: string, cwd: string) {
  return {
    session_id: sessionId,
    agent_id: agentId,
    agent_type: executor,
    cwd,
    tool_name: 'Edit',
    tool_input: { file_path: filePath, old_string: 'a', new_string: 'b' },
  };
}

// The incident's own shape: an executor that pauses for a scope request is
// stopped-and-claimed, and its next write happens after a resume. If a stamped
// terminalAt ended the contract, the guard would go quiet at the one moment the
// worktree is already gone.
test('the dispatch briefing states the isolation contract and the resume trap', () => {
  const agentId = 'a6isolated';
  const { ticket } = dispatched(agentId);
  const briefing = agentsync.renderTicketBriefing(ticket, 'isolation-briefing-token', slug, PROJECT);
  assert.ok(briefing.includes('Worktree isolation contract'), 'the contract is stated');
  assert.ok(briefing.includes('--git-common-dir'), 'the check is named');
  assert.ok(/after any resume/i.test(briefing), 'the resume trap is named');

  const shared = dispatched('a7shared', { sharedTree: true });
  const sharedBriefing = agentsync.renderTicketBriefing(shared.ticket, 'shared-briefing-token', slug, PROJECT);
  assert.ok(!sharedBriefing.includes('Worktree isolation contract'), 'a shared-tree dispatch is not told it is isolated');
});

test('an isolated scope pause preserves its worktree through denial', () => {
  const agentId = 'a10scope-denial';
  const { ticket, sessionId, executor } = dispatched(agentId);
  const linked = path.join(PROJECT, '.claude', 'worktrees', `agent-${agentId}`);
  fs.mkdirSync(path.dirname(linked), { recursive: true });
  execFileSync('git', ['worktree', 'add', '--detach', linked], { cwd: PROJECT, windowsHide: true });
  try {
    assert.equal(store.claimTicket(slug, ticket.ref, 'scope-denial-worker', {
      token: ticket.dispatchNonce,
      executor: ticket.dispatchExecutor,
    }).ok, true);
    const checkpoint = store.checkpointTicket(slug, ticket.ref, 'scope-denial-worker', {
      worktree: linked,
      verify: 'scope denial preserves the live checkpoint',
    }).checkpoint;
    assert.equal(store.requestScope(slug, ticket.ref, 'scope-denial-worker', ['new.js'], { worktree: linked }).ok, true);
    const marker = store.assetPath(slug, ticket.id, `scope-request-${ticket.id}.json`);
    assert.ok(fs.existsSync(marker));
    assert.doesNotMatch(execFileSync('git', ['status', '--porcelain'], { cwd: linked, encoding: 'utf8', windowsHide: true }), /\.sidequest/);

    assert.equal(store.markDispatchStopped(sessionId, executor, agentId, agentId).ok, true);
    const denied = store.denyScopeRequest(slug, ticket.ref, 'isolation-orchestrator', 'The requested file belongs to another ticket.');
    assert.equal(denied.ok, true);
    const afterDeny = store.getTicket(slug, ticket.ref);
    assert.equal(afterDeny.claim.by, 'scope-denial-worker');
    assert.equal(afterDeny.checkpoint.id, checkpoint.id);
    assert.equal(afterDeny.scopeRequest, null);
    assert.equal(afterDeny.dispatch.outcome, 'claimed');
    assert.equal(afterDeny.dispatch.terminalAt, undefined);
    assert.ok(!fs.existsSync(marker));
    assert.doesNotMatch(execFileSync('git', ['status', '--porcelain'], { cwd: linked, encoding: 'utf8', windowsHide: true }), /\.sidequest/);
  } finally {
    execFileSync('git', ['worktree', 'remove', '--force', linked], { cwd: PROJECT, windowsHide: true });
  }
});

test('an isolated scope pause preserves its worktree through approval', () => {
  const agentId = 'a10scope-marker';
  const { ticket, sessionId, executor } = dispatched(agentId);
  const linked = path.join(PROJECT, '.claude', 'worktrees', `agent-${agentId}`);
  fs.mkdirSync(path.dirname(linked), { recursive: true });
  execFileSync('git', ['worktree', 'add', '--detach', linked], { cwd: PROJECT, windowsHide: true });
  try {
    assert.equal(store.claimTicket(slug, ticket.ref, 'scope-marker-worker', {
      token: ticket.dispatchNonce,
      executor: ticket.dispatchExecutor,
    }).ok, true);
    fs.appendFileSync(path.join(linked, 'README.md'), 'uncommitted executor work\n');
    const requested = store.requestScope(slug, ticket.ref, 'scope-marker-worker', ['new.js'], { worktree: linked });
    assert.equal(requested.ok, true);
    const marker = store.assetPath(slug, ticket.id, `scope-request-${ticket.id}.json`);
    assert.ok(fs.existsSync(marker));
    assert.doesNotMatch(execFileSync('git', ['status', '--porcelain'], { cwd: linked, encoding: 'utf8', windowsHide: true }), /\.sidequest/);

    assert.equal(store.markDispatchStopped(sessionId, executor, agentId, agentId).ok, true);
    const paused = store.getTicket(slug, ticket.ref);
    assert.equal(paused.dispatch.outcome, 'scope_paused');
    assert.ok(paused.scopePauseRecovery);
    const recoveryPath = store.assetPath(slug, paused.id, paused.scopePauseRecovery.asset);
    assert.match(fs.readFileSync(recoveryPath, 'utf8'), /uncommitted executor work/);
    const recovered = path.join(PROJECT, '.claude', 'worktrees', `recovered-${agentId}`);
    execFileSync('git', ['worktree', 'add', '--detach', recovered], { cwd: PROJECT, windowsHide: true });
    try {
      execFileSync('git', ['apply', '--check', recoveryPath], { cwd: recovered, windowsHide: true });
      execFileSync('git', ['apply', recoveryPath], { cwd: recovered, windowsHide: true });
      assert.match(fs.readFileSync(path.join(recovered, 'README.md'), 'utf8'), /uncommitted executor work/);
    } finally {
      execFileSync('git', ['worktree', 'remove', '--force', recovered], { cwd: PROJECT, windowsHide: true });
    }
    assert.ok(store.dispatchIsolationExpectation({ agentId, sessionId, executor }));

    store.updateTicket(slug, ticket.ref, { files: ['README.md', 'new.js'] });
    const resumed = store.getTicket(slug, ticket.ref);
    assert.ok(!fs.existsSync(marker));
    assert.equal(resumed.dispatch.worktree, linked);
    assert.equal(resumed.dispatch.outcome, 'claimed');
    assert.equal(resumed.dispatch.terminalAt, undefined);
    assert.match(fs.readFileSync(path.join(linked, 'README.md'), 'utf8'), /uncommitted executor work/);
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: linked, encoding: 'utf8', windowsHide: true });
    assert.match(status, /README\.md/);
    assert.doesNotMatch(status, /\.sidequest/);
  } finally {
    execFileSync('git', ['worktree', 'remove', '--force', linked], { cwd: PROJECT, windowsHide: true });
  }
});

test('a missing paused worktree releases the claim and carries its snapshot into redispatch', () => {
  const agentId = 'a11scope-recovery';
  const { ticket, sessionId, executor } = dispatched(agentId);
  const linked = path.join(PROJECT, '.claude', 'worktrees', `agent-${agentId}`);
  fs.mkdirSync(path.dirname(linked), { recursive: true });
  execFileSync('git', ['worktree', 'add', '--detach', linked], { cwd: PROJECT, windowsHide: true });
  try {
    assert.equal(store.claimTicket(slug, ticket.ref, 'scope-recovery-worker', {
      token: ticket.dispatchNonce,
      executor: ticket.dispatchExecutor,
    }).ok, true);
    fs.appendFileSync(path.join(linked, 'README.md'), 'recover this work\n');
    assert.equal(store.requestScope(slug, ticket.ref, 'scope-recovery-worker', ['new.js'], { worktree: linked }).ok, true);
    assert.equal(store.markDispatchStopped(sessionId, executor, agentId, agentId).ok, true);
    const paused = store.getTicket(slug, ticket.ref);
    assert.ok(paused.scopePauseRecovery);

    execFileSync('git', ['worktree', 'remove', '--force', linked], { cwd: PROJECT, windowsHide: true });
    assert.equal(store.claimReleaseVerdict(store.getTicket(slug, ticket.ref)).kind, 'missing_worktree');
    assert.equal(store.releaseTicket(slug, ticket.ref, 'scope-recovery-worker', { status: 'todo', requireReleaseVerdict: true }).ok, true);
    const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId: `recovery-${agentId}` });
    assert.match(agentsync.renderTicketBriefing(prepared.ticket, prepared.token, slug, PROJECT), /Scope-pause recovery/);
  } finally {
    if (fs.existsSync(linked)) execFileSync('git', ['worktree', 'remove', '--force', linked], { cwd: PROJECT, windowsHide: true });
  }
});


test('a destructive git command is refused while the shared checkout carries uncommitted work', () => {
  const repo = initRepo('sq-destructive-repo-');
  const clean = runHook(GUARD_DESTRUCTIVE, {
    cwd: repo,
    tool_name: 'Bash',
    tool_input: { command: 'git reset --hard origin/main' },
  });
  assert.equal(clean, null, 'a clean tree is not guarded');

  fs.writeFileSync(path.join(repo, 'executor-work.txt'), 'nine files of finished work\n');
  const out = runHook(GUARD_DESTRUCTIVE, {
    cwd: repo,
    tool_name: 'Bash',
    tool_input: { command: 'git reset --hard origin/main' },
  });
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  const reason = out.hookSpecificOutput.permissionDecisionReason;
  assert.ok(reason.includes('executor-work.txt'), 'lists what would be destroyed');
  assert.ok(reason.includes('git stash push'), 'names the recoverable alternative');
  assert.ok(reason.includes('sidequest recover-shared'), 'names the exact recovery action');

  const narrow = runHook(GUARD_DESTRUCTIVE, {
    cwd: repo,
    tool_name: 'Bash',
    tool_input: { command: 'git checkout -- README.md' },
  });
  assert.equal(narrow, null, 'discarding one named path stays allowed');

  const elsewhere = runHook(GUARD_DESTRUCTIVE, {
    cwd: os.tmpdir(),
    tool_name: 'Bash',
    tool_input: { command: `git -C "${repo.replace(/\\/g, '/')}" clean -fd` },
  });
  assert.equal(elsewhere.hookSpecificOutput.permissionDecision, 'deny', 'git -C targets the named repo');
});

test('published-branch pushes and manual tags need the current session publish lock', () => {
  const repo = initRepo('sq-published-branch-');
  const project = store.ensureProject(repo);
  store.setBoardConfig(project.slug, { integrationBranch: 'dev' });
  const sessionId = `release-owner-${Date.now()}`;
  const payload = (command: string, tool_name: string = 'Bash', owner: string = 'other-session') => ({
    cwd: repo,
    session_id: owner,
    tool_name,
    tool_input: { command },
  });
  const denied = [
    'git tag v3.208.0',
    'git tag -a v3.208.0 -m release',
    'git push origin main',
    'git push origin HEAD:main',
    'git push --force origin HEAD:main',
    'git push origin +main',
    'git push origin main:',
    'git push upstream HEAD:main',
    'git push origin --tags',
    'git push origin dev --follow-tags',
  ];
  for (const command of denied) {
    const out = runHook(GUARD_DESTRUCTIVE, payload(command, command.includes('HEAD:main') ? 'PowerShell' : 'Bash'));
    assert.ok(out, command);
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny', command);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /local early warning/);
  }
  for (const command of ['git status', 'git fetch origin', 'git tag --list', 'git push origin dev', 'git push upstream HEAD:dev', 'echo "; git tag v3.208.0"']) {
    assert.equal(runHook(GUARD_DESTRUCTIVE, payload(command)), null, command);
  }

  fs.writeFileSync(path.join(repo, '.git', 'sidequest-publish.lock'), JSON.stringify({
    transient: true,
    sessionId,
    at: new Date().toISOString(),
  }));
  const other = initRepo('sq-published-branch-other-');
  const crossRepo = runHook(GUARD_DESTRUCTIVE, payload(`git -C "${repo}" status; git -C "${other}" tag v3.208.0`, 'Bash', sessionId));
  assert.equal(crossRepo.hookSpecificOutput.permissionDecision, 'deny');
  for (const command of denied) {
    assert.equal(runHook(GUARD_DESTRUCTIVE, payload(command, 'PowerShell', sessionId)), null, command);
  }
});

test('recover-shared refuses a named stash that misses dirty paths', () => {
  const repo = initRepo('sq-recover-missing-');
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
  fs.writeFileSync(path.join(repo, 'preserved.txt'), 'saved first\n');
  git(['stash', 'push', '-u', '-m', 'sidequest incomplete recovery fixture']);
  fs.writeFileSync(path.join(repo, 'unpreserved.txt'), 'still at risk\n');

  assert.throws(
    () => runCli(['recover-shared', '--project', repo, '--stash', 'stash@{0}', '--yes']),
    /does not preserve: unpreserved\.txt/
  );
  assert.equal(fs.existsSync(path.join(repo, 'unpreserved.txt')), true, 'the dirty file stays in place after a failed recovery check');
});

test('recover-shared verifies a named stash before cleaning a dirty shared checkout', () => {
  const repo = initRepo('sq-recover-shared-');
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
  fs.writeFileSync(path.join(repo, 'executor-work.txt'), 'preserved executor work\n');
  git(['stash', 'push', '-u', '-m', 'sidequest recovery fixture']);
  git(['stash', 'apply', 'stash@{0}']);

  const output = runCli(['recover-shared', '--project', repo, '--stash', 'stash@{0}', '--yes']);
  assert.equal(git(['status', '--porcelain']), '', 'the shared checkout is clean after recovery');
  assert.equal(fs.existsSync(path.join(repo, 'executor-work.txt')), false, 'the destructive cleanup ran only after verification');
  assert.ok(output.includes('stash stash@{0}'), 'prints the named stash evidence');
  assert.ok(output.includes('executor-work.txt'), 'prints the covered path evidence');
  assert.ok(git(['stash', 'list', '--format=%gd']).includes('stash@{0}'), 'the preserved stash remains recoverable');
});

test('closure refusals name the next legal action instead of only their precondition', () => {
  const agentId = 'a8closure';
  const { ticket } = dispatched(agentId);
  assert.equal(store.claimTicket(slug, ticket.ref, 'sq826-worker', {
    token: ticket.dispatchNonce,
    executor: ticket.dispatchExecutor,
  }).ok, true);

  const grooming = store.completeTicketAsControlPlane(slug, ticket.ref, {
    by: 'orchestrator',
    purpose: 'grooming',
    reason: 'The work already shipped in a manual commit.',
  });
  assert.equal(grooming.reason, 'active_dispatch');
  assert.ok(grooming.message.includes(`sidequest release ${ticket.ref} --by sq826-worker`), 'names the release that unblocks it');

  const integration = store.completeTicketAsControlPlane(slug, ticket.ref, {
    by: 'orchestrator',
    purpose: 'integration',
    reason: 'Integrated by hand out of the shared tree.',
  });
  assert.equal(integration.reason, 'submission_required');
  assert.ok(/commit .*then submit|commit and then submit/i.test(integration.message), 'says what produces a submission');
  assert.ok(integration.message.includes('without --integration'), 'names the closure that does work here');
});
