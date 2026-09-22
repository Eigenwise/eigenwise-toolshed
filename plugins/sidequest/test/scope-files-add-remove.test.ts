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

function createClaimedDispatch() {
  const fixture = freshProject();
  const { project, store } = fixture;
  const ticket = store.createTicket(project, {
    title: 'Keep scope widening additive',
    category: 'debugging',
    files: ['plugins/sidequest/src/lib/store/tickets.ts'],
  });
  const sessionId = `scope-add-remove-${process.pid}`;
  const prepared = store.prepareDispatch(project, ticket.ref, { allowUnscoped: true, sessionId });
  assert.equal(store.recordDispatchLaunch(project, ticket.ref, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    sessionId,
    agentName: 'scope-add-remove-worker',
  }).ok, true);
  assert.equal(store.bindDispatchWorktreeCreation(project, sessionId, path.join(fixture.repository, 'worker')).ok, true);
  assert.equal(store.claimTicket(project, ticket.ref, 'scope-add-remove-worker', {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);
  return { project, ticket: store.getTicket(project, ticket.ref), store };
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

test('removeFiles against a live isolated dispatch strips the path from declaredFiles too', () => {
  const fixture = createClaimedDispatch();
  const declared = 'plugins/sidequest/src/lib/store/tickets.ts';
  assert.ok(fixture.ticket.dispatch.declaredFiles.includes(declared));
  const updated = fixture.store.updateTicket(fixture.project, fixture.ticket.ref, {
    removeFiles: [declared],
    by: 'scope-add-remove-orchestrator',
  }, undefined, { allowLiveClaimCloseoutUpdate: true });
  assert.deepEqual(updated.files, []);
  // The isolated dispatch sheds it immediately, so a running executor loses a path
  // it may already have written. The CLI help and orchestration.md say so.
  assert.equal(updated.dispatch.declaredFiles.includes(declared), false);
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
