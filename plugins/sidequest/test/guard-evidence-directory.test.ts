import './_temp-cleanup.js';
import './_sidequest-install-fixture.js';
import './_hook-runtime.js';
'use strict';

// GH-163. `~/.claude` is a Git checkout on machines that keep dotfiles in one, so the Sidequest home
// and every board-owned `projects/<slug>/verification/<ref>` directory sit inside a repository that
// belongs to nobody's dispatch. The isolation guard resolved that enclosing checkout and asked the
// write lease about it, so an executor writing the evidence the briefing told it to write was
// refused for having "no write lease for the observed worktree" — while the same path through Bash,
// which this hook never gates, succeeded. These cover the exemption and its edges.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function initRepo(prefix: string) {
  const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Sidequest Test']);
  git(['config', 'user.email', 'sidequest-test@example.invalid']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'evidence fixture\n');
  git(['add', '.']);
  git(['commit', '-m', 'base']);
  return repo;
}

// The whole point of the fixture: the board home is INSIDE a Git checkout that is not any project's,
// standing in for the dotfiles repository that holds ~/.claude.
const DOTFILES = initRepo('sq-evidence-dotfiles-');
const SIDEQUEST_HOME = path.join(DOTFILES, 'sidequest');
fs.mkdirSync(SIDEQUEST_HOME, { recursive: true });
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;

const store = require('../lib/store.js');

const HOOKS = path.join(__dirname, '..', 'hooks');
const GUARD_ISOLATION = path.join(HOOKS, 'guard-worktree-isolation.js');

const PROJECT = initRepo('sq-evidence-project-');
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

function dispatched(agentId: string, options: { sharedTree?: boolean } = {}) {
  const ticket = store.createTicket(slug, {
    title: `evidence fixture ${agentId}`,
    category: 'codebase-exploration',
    description: 'A fixture dispatch that records a board-owned evidence directory.',
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
    tool_name: 'Write',
    tool_input: { file_path: filePath, content: 'evidence\n' },
  };
}

test('a write into the dispatch evidence directory is allowed when the board home sits inside a foreign checkout', () => {
  const agentId = 'e1evidence';
  const { ticket, sessionId, executor } = dispatched(agentId, { sharedTree: true });
  const evidenceDirectory = String(ticket.dispatch.evidenceDirectory);
  assert.ok(
    evidenceDirectory.startsWith(fs.realpathSync.native(SIDEQUEST_HOME)) || evidenceDirectory.startsWith(SIDEQUEST_HOME),
    `the fixture evidence directory must live under the board home: ${evidenceDirectory}`,
  );
  const target = path.join(evidenceDirectory, 'probe.log');
  assert.equal(runHook(GUARD_ISOLATION, writePayload(agentId, executor, sessionId, target, PROJECT)), null);
});

test('a write to a nested path under the evidence directory is allowed', () => {
  const agentId = 'e2evidence';
  const { ticket, sessionId, executor } = dispatched(agentId, { sharedTree: true });
  const target = path.join(String(ticket.dispatch.evidenceDirectory), 'screenshots', 'board.png');
  assert.equal(runHook(GUARD_ISOLATION, writePayload(agentId, executor, sessionId, target, PROJECT)), null);
});

test('a write elsewhere in the same foreign checkout is still refused for want of a lease', () => {
  const agentId = 'e3sibling';
  const { ticket, sessionId, executor } = dispatched(agentId, { sharedTree: true });
  const target = path.join(SIDEQUEST_HOME, 'board.sqlite3');
  const out = runHook(GUARD_ISOLATION, writePayload(agentId, executor, sessionId, target, PROJECT));
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  const reason = out.hookSpecificOutput.permissionDecisionReason;
  assert.ok(reason.includes(ticket.ref), 'names the ticket');
  assert.match(reason, /no write lease for the observed worktree/);
});

test('the dotfiles checkout holding the board home stays refused outside the evidence directory', () => {
  const agentId = 'e4dotfiles';
  const { sessionId, executor } = dispatched(agentId, { sharedTree: true });
  const target = path.join(DOTFILES, 'README.md');
  const out = runHook(GUARD_ISOLATION, writePayload(agentId, executor, sessionId, target, PROJECT));
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /no write lease for the observed worktree/);
});

test('an isolated dispatch writing into the shared project checkout is still refused', () => {
  const agentId = 'e5isolated';
  const { ticket, sessionId, executor } = dispatched(agentId);
  assert.equal(ticket.dispatch.sharedTree, false);
  const target = path.join(PROJECT, 'README.md');
  const out = runHook(GUARD_ISOLATION, writePayload(agentId, executor, sessionId, target, PROJECT));
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /writing to:/);
});

// Direct unit tests of boardVerificationEvidencePath, far cheaper than spawning the hook: these need
// only a root directory, never a registered project, a dispatched ticket, or the isolation guard.
test('boardVerificationEvidencePath accepts a file directly inside the recorded evidence directory', () => {
  const evidenceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-evidence-direct-'));
  const target = path.join(evidenceDirectory, 'probe.log');
  assert.equal(store.boardVerificationEvidencePath(target, evidenceDirectory), true);
});

test('boardVerificationEvidencePath accepts a nested path under the recorded evidence directory', () => {
  const evidenceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-evidence-direct-'));
  const target = path.join(evidenceDirectory, 'screenshots', 'board.png');
  assert.equal(store.boardVerificationEvidencePath(target, evidenceDirectory), true);
});

// Boundary case from review item 6: the `projects/<slug>/verification` directory itself, one level
// above the ticket's own evidence directory, must stay refused rather than being treated as nested
// inside it.
test('boardVerificationEvidencePath refuses the verification directory itself, one level above the recorded evidence directory', () => {
  const verificationDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-evidence-verification-'));
  const evidenceDirectory = path.join(verificationDirectory, 'SQ-999');
  fs.mkdirSync(evidenceDirectory, { recursive: true });
  assert.equal(store.boardVerificationEvidencePath(verificationDirectory, evidenceDirectory), false);
});

// Boundary case from review item 6: traversal back out of the evidence directory towards a sibling
// (standing in for the database file) must stay refused.
test('boardVerificationEvidencePath refuses traversal back out of the recorded evidence directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-evidence-traversal-'));
  const evidenceDirectory = path.join(root, 'projects', 'slug', 'verification', 'SQ-1');
  fs.mkdirSync(evidenceDirectory, { recursive: true });
  fs.writeFileSync(path.join(root, 'board.sqlite3'), '');
  const target = path.join(evidenceDirectory, '..', '..', '..', '..', 'board.sqlite3');
  assert.equal(store.boardVerificationEvidencePath(target, evidenceDirectory), false);
});

// Review item 5: a symlink at the final path component that does not resolve to anything yet must not
// escape the containment check the way a live symlink already does.
test('boardVerificationEvidencePath refuses a dangling symlink as the requested path', () => {
  const evidenceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-evidence-symlink-'));
  const target = path.join(evidenceDirectory, 'dangling.log');
  fs.symlinkSync(path.join(evidenceDirectory, 'does-not-exist-yet.log'), target);
  assert.equal(store.boardVerificationEvidencePath(target, evidenceDirectory), false);
});

test('boardVerificationEvidencePath refuses without a recorded evidence directory or a requested path', () => {
  const evidenceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-evidence-empty-'));
  assert.equal(store.boardVerificationEvidencePath(path.join(evidenceDirectory, 'x.log'), ''), false);
  assert.equal(store.boardVerificationEvidencePath('', evidenceDirectory), false);
});
