import './_temp-cleanup.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { stubSidequestInstall } from './_sidequest-install-fixture.js';

stubSidequestInstall();

// GitHub #173: update --files replaced the whole declared list, so widening scope
// for a scope refusal silently dropped the original files. addFiles/removeFiles
// adjust the list in place instead.
function freshProject() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-scope-add-remove-home-'));
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-scope-add-remove-repo-'));
  execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: repository, windowsHide: true });
  execFileSync('git', ['-c', 'user.name=Sidequest Tests', '-c', 'user.email=sidequest-test@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'fixture'], { cwd: repository, windowsHide: true });
  process.env.SIDEQUEST_HOME = home;
  process.env.CLAUDE_PROJECT_DIR = repository;
  const store = require('../lib/store.js');
  const project = store.ensureProject(repository).slug;
  return { project, repository, store };
}

// realWorktree binds a checkout git can read, so the bound checkout's own writes are
// visible to the live-claim removal guard. Without it the bound path does not exist.
function createClaimedDispatch(options: { files?: string[]; realWorktree?: boolean } = {}) {
  const fixture = freshProject();
  const { project, store } = fixture;
  const ticket = store.createTicket(project, {
    title: 'Keep scope widening additive',
    category: 'debugging',
    files: options.files || ['plugins/sidequest/src/lib/store/tickets.ts'],
  });
  const worktree = path.join(fixture.repository, 'worker');
  if (options.realWorktree) execFileSync('git', ['worktree', 'add', '--quiet', '--detach', worktree], { cwd: fixture.repository, windowsHide: true });
  const sessionId = `scope-add-remove-${process.pid}`;
  const prepared = store.prepareDispatch(project, ticket.ref, { allowUnscoped: true, sessionId });
  assert.equal(store.recordDispatchLaunch(project, ticket.ref, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    sessionId,
    agentName: 'scope-add-remove-worker',
  }).ok, true);
  assert.equal(store.bindDispatchWorktreeCreation(project, sessionId, worktree).ok, true);
  assert.equal(store.claimTicket(project, ticket.ref, 'scope-add-remove-worker', {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);
  return { project, ticket: store.getTicket(project, ticket.ref), store, worktree };
}

function liveRemoval(fixture: ReturnType<typeof createClaimedDispatch>, removeFiles: string[]) {
  return fixture.store.updateTicket(fixture.project, fixture.ticket.ref, {
    removeFiles,
    by: 'scope-add-remove-orchestrator',
  }, undefined, { allowLiveClaimCloseoutUpdate: true });
}

test('update addFiles appends and keeps the original declared list', () => {
  const { project, store } = freshProject();
  const ticket = store.createTicket(project, { title: 'addFiles keeps the rest', category: 'debugging', files: ['a.ts'] });
  const updated = store.updateTicket(project, ticket.ref, { addFiles: ['b.ts'] });
  assert.deepEqual(updated.files, ['a.ts', 'b.ts']);
});

test('update removeFiles drops only the named paths', () => {
  const { project, store } = freshProject();
  const ticket = store.createTicket(project, { title: 'removeFiles is selective', category: 'debugging', files: ['a.ts', 'b.ts', 'c.ts'] });
  const updated = store.updateTicket(project, ticket.ref, { removeFiles: ['b.ts'] });
  assert.deepEqual(updated.files, ['a.ts', 'c.ts']);
});

test('update files alone still replaces the whole declared list', () => {
  const { project, store } = freshProject();
  const ticket = store.createTicket(project, { title: 'files still replaces', category: 'debugging', files: ['a.ts', 'b.ts'] });
  const updated = store.updateTicket(project, ticket.ref, { files: ['z.ts'] });
  assert.deepEqual(updated.files, ['z.ts']);
});

test('update refuses mixing files with addFiles or removeFiles', () => {
  const { project, store } = freshProject();
  const ticket = store.createTicket(project, { title: 'mixing refuses', category: 'debugging', files: ['a.ts'] });
  assert.throws(
    () => store.updateTicket(project, ticket.ref, { files: ['z.ts'], addFiles: ['b.ts'] }),
    /cannot mix files with addFiles\/removeFiles/,
  );
  assert.throws(
    () => store.updateTicket(project, ticket.ref, { files: ['z.ts'], removeFiles: ['a.ts'] }),
    /cannot mix files with addFiles\/removeFiles/,
  );
  // Refused, so the declared list stays exactly what it was.
  assert.deepEqual(store.getTicket(project, ticket.ref).files, ['a.ts']);
});

test('a live dispatch reads the widened list on its next scopeRequest', () => {
  const fixture = createClaimedDispatch();
  const newPath = 'plugins/sidequest/src/lib/store/newly-widened.ts';
  // Mirrors the MCP `update` tool, which always passes this option: the
  // orchestrator's main-thread identity, distinct from the claim holder, may
  // widen a live dispatch's scope. The CLI cannot set this option, so a plain
  // CLI update on a live claim still refuses and points at scopeRequest.
  const updated = fixture.store.updateTicket(fixture.project, fixture.ticket.ref, {
    addFiles: [newPath],
    by: 'scope-add-remove-orchestrator',
  }, undefined, { allowLiveClaimCloseoutUpdate: true });
  assert.deepEqual(updated.files, ['plugins/sidequest/src/lib/store/tickets.ts', newPath]);
  assert.ok(updated.dispatch.declaredFiles.some((f: string) => f.toLowerCase() === newPath.toLowerCase()));

  // The same live dispatch's next scopeRequest sees the widened list without
  // another approval round: the path is already covered.
  const result = fixture.store.requestScope(fixture.project, fixture.ticket.ref, fixture.ticket.claim.by, [newPath]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.covered, [newPath]);
});

test('removeFiles against a live isolated dispatch strips an unwritten path from declaredFiles too', () => {
  const kept = 'plugins/sidequest/src/lib/store/tickets.ts';
  const dropped = 'plugins/sidequest/src/lib/store/dispatch.ts';
  const fixture = createClaimedDispatch({ files: [kept, dropped], realWorktree: true });
  assert.ok(fixture.ticket.dispatch.declaredFiles.includes(dropped));
  const updated = liveRemoval(fixture, [dropped]);
  assert.deepEqual(updated.files, [kept]);
  // Nothing in the bound checkout touches it, so shedding it loses no work.
  assert.equal(updated.dispatch.declaredFiles.includes(dropped), false);
  assert.ok(updated.dispatch.declaredFiles.includes(kept));
});

test('removeFiles refuses a live-claim path the bound checkout changed, whether untracked, edited or committed', () => {
  const kept = 'plugins/sidequest/src/lib/store/tickets.ts';
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Sidequest Tests', '-c', 'user.email=sidequest-test@example.invalid', ...args], { cwd, windowsHide: true });
  const untracked = 'plugins/sidequest/src/lib/store/dispatch.ts';
  const edited = 'plugins/sidequest/src/lib/store/edited.ts';
  const committed = 'plugins/sidequest/src/lib/store/committed.ts';
  const fixture = createClaimedDispatch({ files: [kept, untracked, edited, committed], realWorktree: true });
  const write = (file: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(fixture.worktree, file)), { recursive: true });
    fs.writeFileSync(path.join(fixture.worktree, file), body);
  };
  // edited.ts is committed and then modified again, committed.ts is committed only,
  // and dispatch.ts is never added: every one is a change against the dispatch base.
  write(edited, 'v1\n');
  git(fixture.worktree, 'add', edited);
  git(fixture.worktree, 'commit', '--quiet', '-m', 'first edit');
  write(edited, 'v2\n');
  write(committed, 'c\n');
  git(fixture.worktree, 'add', committed);
  git(fixture.worktree, 'commit', '--quiet', '-m', 'committed work');
  write(untracked, 'u\n');

  for (const file of [untracked, edited, committed]) {
    assert.throws(
      () => liveRemoval(fixture, [file]),
      (error: Error) => error.message.includes(`would revoke ${file}`)
        && /already changed since the dispatch base/.test(error.message)
        && /release the claim first/i.test(error.message),
      file,
    );
  }
  const after = fixture.store.getTicket(fixture.project, fixture.ticket.ref);
  assert.deepEqual(after.files, [kept, untracked, edited, committed], 'a refused removal leaves the declared list alone');
  assert.ok(after.dispatch.declaredFiles.includes(untracked));

  // The unwritten path still goes, so the guard is about written work, not removal itself.
  assert.deepEqual(liveRemoval(fixture, [kept]).files, [untracked, edited, committed]);
});

// Without -z git prints a non-ASCII name C-quoted ("caf\303\251.ts"), which no declared
// path matches, so the guard saw the ASCII file but let the accented one be revoked.
test('removeFiles of a directory refuses when the checkout wrote a non-ASCII file under it, committed or untracked', () => {
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Sidequest Tests', '-c', 'user.email=sidequest-test@example.invalid', ...args], { cwd, windowsHide: true });
  const directory = 'plugins/sidequest/src';
  const fixture = createClaimedDispatch({ files: [directory, 'docs'], realWorktree: true });
  const write = (file: string) => {
    fs.mkdirSync(path.dirname(path.join(fixture.worktree, file)), { recursive: true });
    fs.writeFileSync(path.join(fixture.worktree, file), 'x\n');
  };
  const untracked = `${directory}/café.ts`;
  const committed = `${directory}/naïve.ts`;
  write(committed);
  git(fixture.worktree, 'add', committed);
  git(fixture.worktree, 'commit', '--quiet', '-m', 'committed work');
  write(untracked);

  assert.throws(() => liveRemoval(fixture, [directory]), (error: Error) => error.message.includes(untracked) && error.message.includes(committed));
  assert.deepEqual(fixture.store.getTicket(fixture.project, fixture.ticket.ref).files, [directory, 'docs']);
});

test('removeFiles of a directory entry is refused when the checkout changed a file under it, unless another entry still covers it', () => {
  const fixture = createClaimedDispatch({ files: ['plugins/sidequest/src', 'plugins/sidequest/src/lib', 'docs'], realWorktree: true });
  const inner = 'plugins/sidequest/src/lib/store/inner.ts';
  fs.mkdirSync(path.dirname(path.join(fixture.worktree, inner)), { recursive: true });
  fs.writeFileSync(path.join(fixture.worktree, inner), 'x\n');
  assert.throws(() => liveRemoval(fixture, ['plugins/sidequest/src', 'plugins/sidequest/src/lib']), /would revoke plugins\/sidequest\/src\/lib\/store\/inner\.ts/);
  // plugins/sidequest/src still covers the written file, so dropping the narrower entry revokes nothing.
  assert.deepEqual(liveRemoval(fixture, ['plugins/sidequest/src/lib']).files, ['plugins/sidequest/src', 'docs']);
});

test('removeFiles refuses to empty a live claim, which would also drop the implicit release fragment', () => {
  const fixture = createClaimedDispatch({ files: ['a.ts', 'b.ts'], realWorktree: true });
  assert.throws(
    () => liveRemoval(fixture, ['a.ts', 'b.ts']),
    (error: Error) => /no declared files/.test(error.message)
      && error.message.includes(`.release/unreleased/${fixture.ticket.ref}.md`)
      && /Keep at least one declared path, or release the claim first/.test(error.message),
  );
  assert.deepEqual(fixture.store.getTicket(fixture.project, fixture.ticket.ref).files, ['a.ts', 'b.ts']);
  // The same guard holds when the checkout cannot be inspected at all.
  const unbound = createClaimedDispatch({ files: ['only.ts'] });
  assert.throws(() => liveRemoval(unbound, ['only.ts']), /no declared files/);
  assert.deepEqual(unbound.store.getTicket(unbound.project, unbound.ticket.ref).files, ['only.ts']);
});

test('removeFiles fails closed when the bound checkout exists but git cannot read it', () => {
  const fixture = createClaimedDispatch({ files: ['a.ts', 'b.ts'], realWorktree: true });
  // Breaking the worktree's .git pointer leaves the directory in place but unreadable to git.
  // Windows marks the pointer hidden, and writeFileSync cannot open a hidden file, so remove it first.
  const gitPath = path.join(fixture.worktree, '.git');
  fs.rmSync(gitPath, { force: true, recursive: true });
  fs.writeFileSync(gitPath, 'gitdir: /nonexistent/sq-broken-worktree\n');
  assert.throws(() => liveRemoval(fixture, ['b.ts']), /cannot confirm the bound checkout .* git could not read it\. Release the claim first/);
  assert.deepEqual(fixture.store.getTicket(fixture.project, fixture.ticket.ref).files, ['a.ts', 'b.ts']);
});

test('removeFiles on a released ticket is unguarded, since no claim holds work in the checkout', () => {
  const { project, store } = freshProject();
  const ticket = store.createTicket(project, { title: 'unclaimed removal', category: 'debugging', files: ['a.ts'] });
  assert.deepEqual(store.updateTicket(project, ticket.ref, { removeFiles: ['a.ts'] }).files, []);
});

test('removeFiles names the paths a ticket does not declare instead of reporting a silent no-op', () => {
  const { project, store } = freshProject();
  const ticket = store.createTicket(project, { title: 'a typo is not a success', category: 'debugging', files: ['a.ts', 'b.ts'] });
  assert.throws(
    () => store.updateTicket(project, ticket.ref, { removeFiles: ['a.tsx'] }),
    /removeFiles named a.tsx, which this ticket does not declare/,
  );
  assert.deepEqual(store.getTicket(project, ticket.ref).files, ['a.ts', 'b.ts']);
});

test('addFiles and removeFiles naming the same path in one call resolve as a removal', () => {
  const { project, store } = freshProject();
  const ticket = store.createTicket(project, { title: 'additions apply first', category: 'debugging', files: ['a.ts'] });
  const updated = store.updateTicket(project, ticket.ref, { addFiles: ['b.ts'], removeFiles: ['b.ts'] });
  assert.deepEqual(updated.files, ['a.ts']);
});

test('a mixed files patch is refused before any other field lands', () => {
  const { project, store } = freshProject();
  const ticket = store.createTicket(project, { title: 'original title', category: 'debugging', files: ['a.ts'] });
  assert.throws(
    () => store.updateTicket(project, ticket.ref, { title: 'renamed by a refused patch', files: ['z.ts'], addFiles: ['b.ts'] }),
    /cannot mix files with addFiles\/removeFiles/,
  );
  const after = store.getTicket(project, ticket.ref);
  assert.equal(after.title, 'original title');
  assert.deepEqual(after.files, ['a.ts']);
});
