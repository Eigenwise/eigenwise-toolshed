import './_temp-cleanup.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { stubSidequestInstall } from './_sidequest-install-fixture.js';

stubSidequestInstall();

// SQ-13: the orchestrator's scopeRequest was refused with not_owner, so there
// was no append-only path for it at all. grantScope grants the ticket's most
// recently refused request outright and widens declaredFiles for the live
// dispatch's next scopeRequest — no redispatch needed.
function createClaimedDispatch() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-scope-grant-home-'));
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-scope-grant-repo-'));
  execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: repository, windowsHide: true });
  execFileSync('git', ['-c', 'user.name=Sidequest Tests', '-c', 'user.email=sidequest-test@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'fixture'], { cwd: repository, windowsHide: true });
  process.env.SIDEQUEST_HOME = home;
  process.env.CLAUDE_PROJECT_DIR = repository;
  const store = require('../lib/store.js');
  const project = store.ensureProject(repository).slug;
  const ticket = store.createTicket(project, {
    title: 'Grant a refused scope request',
    category: 'debugging',
    files: ['plugins/sidequest/src/lib/store/tickets.ts'],
  });
  const sessionId = `scope-grant-${process.pid}`;
  const prepared = store.prepareDispatch(project, ticket.ref, { allowUnscoped: true, sessionId });
  assert.equal(store.recordDispatchLaunch(project, ticket.ref, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    sessionId,
    agentName: 'scope-grant-worker',
  }).ok, true);
  assert.equal(store.bindDispatchWorktreeCreation(project, sessionId, path.join(repository, 'worker')).ok, true);
  assert.equal(store.claimTicket(project, ticket.ref, 'scope-grant-worker', {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);
  return { project, ticket: store.getTicket(project, ticket.ref), store };
}

test('grantScope has nothing to grant before any scope request is refused', () => {
  const fixture = createClaimedDispatch();
  const result = fixture.store.grantScope(fixture.project, fixture.ticket.ref, 'orchestrator');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_pending_scope_request');
});

test('grantScope resolves a pending refused request and widens declaredFiles without redispatch', () => {
  const fixture = createClaimedDispatch();
  const refusedPath = 'plugins/sidequest/.claude/skills/verify/SKILL.md';
  const refusal = fixture.store.requestScope(fixture.project, fixture.ticket.ref, 'scope-grant-worker', [refusedPath]);
  assert.equal(refusal.state, 'refused');

  const granted = fixture.store.grantScope(fixture.project, fixture.ticket.ref, 'scope-grant-orchestrator');
  assert.equal(granted.ok, true);
  assert.deepEqual(granted.granted, [refusedPath]);

  const ticket = fixture.store.getTicket(fixture.project, fixture.ticket.ref);
  assert.ok(ticket.files.some((f: string) => f.toLowerCase() === refusedPath.toLowerCase()));
  assert.equal(ticket.scopeResolution.state, 'granted');
  assert.equal(ticket.scopeResolution.grantedBy, 'scope-grant-orchestrator');
  // No redispatch: the same live dispatch's declaredFiles already carries it.
  assert.ok(ticket.dispatch.declaredFiles.some((f: string) => f.toLowerCase() === refusedPath.toLowerCase()));

  // Granted once; nothing pending remains to grant again.
  const again = fixture.store.grantScope(fixture.project, fixture.ticket.ref, 'scope-grant-orchestrator');
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'no_pending_scope_request');
});
