import './_temp-cleanup.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

function createClaimedDispatch() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-scope-evidence-home-'));
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-scope-evidence-repo-'));
  execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: repository, windowsHide: true });
  execFileSync('git', ['-c', 'user.name=Sidequest Tests', '-c', 'user.email=sidequest-test@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'fixture'], { cwd: repository, windowsHide: true });
  process.env.SIDEQUEST_HOME = home;
  process.env.CLAUDE_PROJECT_DIR = repository;
  const store = require('../lib/store.js');
  const project = store.ensureProject(repository).slug;
  const ticket = store.createTicket(project, {
    title: 'Keep scope requests accurate',
    category: 'debugging',
    files: ['plugins/sidequest/src/lib/store/tickets.ts'],
  });
  const sessionId = `scope-evidence-${process.pid}`;
  const prepared = store.prepareDispatch(project, ticket.ref, { allowUnscoped: true, sessionId });
  assert.equal(store.recordDispatchLaunch(project, ticket.ref, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    sessionId,
    agentName: 'scope-evidence-worker',
  }).ok, true);
  assert.equal(store.bindDispatchWorktreeCreation(project, sessionId, path.join(repository, 'worker')).ok, true);
  assert.equal(store.claimTicket(project, ticket.ref, 'scope-evidence-worker', {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);
  return { project, ticket: store.getTicket(project, ticket.ref), store };
}

test('scopeRequest refuses board-owned verification evidence with its directory guidance', () => {
  const fixture = createClaimedDispatch();
  const evidencePath = path.join(fixture.ticket.dispatch.evidenceDirectory, 'probe.log');
  const result = fixture.store.requestScope(fixture.project, fixture.ticket.ref, 'scope-evidence-worker', [evidencePath]);

  assert.equal(result.reason, 'invalid_scope');
  assert.match(result.message, /The refused path is board-owned verification evidence/);
  assert.match(result.message, /Verification evidence belongs in/);
});
