import './_temp-cleanup.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { stubSidequestInstall } from './_sidequest-install-fixture.js';

stubSidequestInstall();

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

function claimStoryMember(store: any, project: string, repository: string, storyId: string, files: string[], by: string) {
  const ticket = store.createTicket(project, { title: `Story member ${by}`, category: 'debugging', storyId, files });
  const sessionId = `${by}-${process.pid}`;
  const prepared = store.prepareDispatch(project, ticket.ref, { allowUnscoped: true, sessionId });
  assert.equal(store.recordDispatchLaunch(project, ticket.ref, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    sessionId,
    agentName: by,
  }).ok, true);
  assert.equal(store.bindDispatchWorktreeCreation(project, sessionId, path.join(repository, by)).ok, true);
  assert.equal(store.claimTicket(project, ticket.ref, by, { token: prepared.token, executor: prepared.ticket.dispatchExecutor }).ok, true);
  return ticket.ref;
}

test('scopeRequest answers an identical same-story request identically for every member (GH-286)', () => {
  const fixture = createClaimedDispatch();
  const repository = fixture.store.readMeta(fixture.project).path;
  for (const file of ['frontend/apps/web/package.json', 'frontend/apps/web/lib/trace/source-catalog.ts', 'frontend/apps/web/lib/trace/spans.ts', 'frontend/apps/web/app/api/documents/route.ts']) {
    fs.mkdirSync(path.dirname(path.join(repository, file)), { recursive: true });
    fs.writeFileSync(path.join(repository, file), '{}\n');
  }
  const story = fixture.store.createStory(fixture.project, { title: 'Source catalog story' });
  const libMember = claimStoryMember(fixture.store, fixture.project, repository, story.id, ['frontend/apps/web/lib/trace/spans.ts'], 'story-lib-worker');
  const appMember = claimStoryMember(fixture.store, fixture.project, repository, story.id, ['frontend/apps/web/app/api/documents/route.ts'], 'story-app-worker');
  const catalog = 'frontend/apps/web/lib/trace/source-catalog.ts';

  const libResult = fixture.store.requestScope(fixture.project, libMember, 'story-lib-worker', [catalog]);
  const appResult = fixture.store.requestScope(fixture.project, appMember, 'story-app-worker', [catalog]);

  assert.equal(libResult.state, 'granted');
  assert.equal(appResult.state, libResult.state);
  assert.deepEqual(appResult.approved, libResult.approved);
});

test('scopeRequest names why each path missed package-surface approval (GH-286)', () => {
  const fixture = createClaimedDispatch();
  const repository = fixture.store.readMeta(fixture.project).path;
  fs.mkdirSync(path.join(repository, 'plugins', 'sidequest'), { recursive: true });
  fs.mkdirSync(path.join(repository, 'plugins', 'sidequest', 'test'), { recursive: true });
  assert.equal(fixture.store.setBoardConfig(fixture.project, { autoApproveTestScope: false }).ok, true);
  const requested = ['plugins/sidequest/docs/guide.md', 'plugins/sidequest/package.json', 'plugins/sidequest/test/guide.test.ts', 'notes/readme.md', 'plugins/sidequest/src/lib/store/config.ts'];
  const result = fixture.store.requestScope(fixture.project, fixture.ticket.ref, 'scope-source-worker', requested);
  const comment = fixture.store.getTicket(fixture.project, fixture.ticket.ref).comments.at(-1).body;

  assert.equal(result.state, 'refused');
  assert.deepEqual(result.approved, ['plugins/sidequest/src/lib/store/config.ts']);
  assert.match(comment, /plugins\/sidequest\/docs\/guide\.md: package surface plugins\/sidequest\/docs matches no declared file in this ticket[;.]/);
  assert.match(comment, /plugins\/sidequest\/package\.json: a protected or pattern path is never auto-approved/);
  assert.match(comment, /plugins\/sidequest\/test\/guide\.test\.ts: test-directory auto-approval is off on this board/);
  assert.match(comment, /notes\/readme\.md: no package root contains it/);
});
