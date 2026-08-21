import './_temp-cleanup.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

function createClaimedDispatch() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-scope-source-home-'));
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-scope-source-repo-'));
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
  const sessionId = `scope-source-${process.pid}`;
  const prepared = store.prepareDispatch(project, ticket.ref, { allowUnscoped: true, sessionId });
  assert.equal(store.recordDispatchLaunch(project, ticket.ref, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    sessionId,
    agentName: 'scope-source-worker',
  }).ok, true);
  assert.equal(store.bindDispatchWorktreeCreation(project, sessionId, path.join(repository, 'worker')).ok, true);
  assert.equal(store.claimTicket(project, ticket.ref, 'scope-source-worker', {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);
  return { project, ticket: store.getTicket(project, ticket.ref), store };
}

test('scopeRequest identifies refused tracked source as outside declared files', () => {
  const fixture = createClaimedDispatch();
  const sourcePath = 'plugins/sidequest/.claude/skills/verify/SKILL.md';
  const result = fixture.store.requestScope(fixture.project, fixture.ticket.ref, 'scope-source-worker', [sourcePath]);
  const comment = fixture.store.getTicket(fixture.project, fixture.ticket.ref).comments.at(-1).body;

  assert.equal(result.state, 'refused');
  assert.match(comment, /The refused path is outside this ticket's declared files/);
  assert.doesNotMatch(comment, /Verification evidence belongs in/);
});
