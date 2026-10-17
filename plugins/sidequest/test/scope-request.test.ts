import './_temp-cleanup.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { stubSidequestInstall } from './_sidequest-install-fixture.js';

stubSidequestInstall();

function createClaimedDispatch(files: string[] = ['plugins/sidequest/src/lib/store/tickets.ts']) {
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
    files,
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
  assert.match(result.message, /admitted helpers can write verification evidence/);
  assert.match(result.message, /without requesting scope/);
});

test('scopeRequest identifies ticket-specific repository probe output as verification evidence', () => {
  const fixture = createClaimedDispatch();
  const evidencePath = `plugins/sidequest/artifacts/${fixture.ticket.ref}-probe.png`;
  const result = fixture.store.requestScope(fixture.project, fixture.ticket.ref, 'scope-evidence-worker', [evidencePath]);
  const comment = fixture.store.getTicket(fixture.project, fixture.ticket.ref).comments.at(-1).body;

  assert.equal(result.state, 'refused');
  assert.match(comment, /The refused path is board-owned verification evidence/);
  assert.match(comment, /admitted helpers can write verification evidence/);
  assert.match(comment, /without requesting scope/);
});

test('scopeRequest inside a whole-tree unscoped dispatch reads as covered, not refused (GH-341)', () => {
  const fixture = createClaimedDispatch([]);
  assert.deepEqual(fixture.ticket.dispatch.declaredFiles, ['**']);
  const result = fixture.store.requestScope(fixture.project, fixture.ticket.ref, 'scope-evidence-worker', ['src/app.ts']);
  const comments = fixture.store.getTicket(fixture.project, fixture.ticket.ref).comments || [];

  assert.equal(result.state, 'granted');
  assert.deepEqual(result.covered, ['src/app.ts']);
  assert.deepEqual(result.approved, []);
  assert.equal(comments.some((comment: { body: string }) => /declares no files/.test(comment.body)), false);
});

// GitHub #403: an addition the board auto-approves leaves no refused path, so the
// result must not carry "Scope expansion refused: ." beside a granted state.
test('scopeRequest that auto-approves its addition carries no refusal message', () => {
  const fixture = createClaimedDispatch();
  const sibling = 'plugins/sidequest/src/lib/store/auto-approved-sibling.ts';
  const result = fixture.store.requestScope(fixture.project, fixture.ticket.ref, 'scope-evidence-worker', [sibling]);
  const comments = fixture.store.getTicket(fixture.project, fixture.ticket.ref).comments || [];

  assert.equal(result.state, 'granted');
  assert.deepEqual(result.approved, [sibling]);
  assert.deepEqual(result.refused, []);
  assert.equal(result.message, undefined);
  assert.equal(comments.some((comment: { body: string }) => /Scope expansion refused/.test(comment.body)), false);
});

test('scopeRequest names only the refused paths when one addition is approved and another is not', () => {
  const fixture = createClaimedDispatch();
  const sibling = 'plugins/sidequest/src/lib/store/auto-approved-sibling.ts';
  const outside = 'docs/not-in-this-package.md';
  const result = fixture.store.requestScope(fixture.project, fixture.ticket.ref, 'scope-evidence-worker', [sibling, outside]);

  assert.equal(result.state, 'refused');
  assert.equal(result.message, `Scope expansion refused: ${outside}.`);
});

function trackBuildFiles(fixture: ReturnType<typeof createClaimedDispatch>, files: string[]) {
  const repository = fixture.store.readMeta(fixture.project).path;
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(repository, file)), { recursive: true });
    fs.writeFileSync(path.join(repository, file), '');
  }
  execFileSync('git', ['add', '--', ...files], { cwd: repository, windowsHide: true });
}

test('scopeRequest grants tracked outputs of declared and already granted sources', () => {
  const sources = ['plugins/sidequest/src/lib/store/tickets.ts', 'plugins/sidequest/src/hooks/worktree-create.ts', 'plugins/sidequest/src/bin/sidequest.ts'];
  const outputs = sources.map((source) => source.replace('/src/', '/').replace(/\.ts$/, '.js'));
  const fixture = createClaimedDispatch(sources.slice(0, 2));
  trackBuildFiles(fixture, [...sources, ...outputs]);
  const sourceGrant = fixture.store.requestScope(fixture.project, fixture.ticket.ref, 'scope-evidence-worker', [sources[2]]);
  assert.equal(sourceGrant.state, 'granted');

  const result = fixture.store.requestScope(fixture.project, fixture.ticket.ref, 'scope-evidence-worker', outputs);
  assert.equal(result.state, 'granted');
  assert.deepEqual(result.approved, outputs);
  assert.deepEqual(result.refused, []);
  for (const source of sources) {
    assert.ok(result.comment.body.includes('build output of ' + source));
  }
  assert.ok(fixture.store.getTicket(fixture.project, fixture.ticket.ref).files.includes(outputs[2]));
});

test('scopeRequest refuses outputs without a granted source and untracked or nested hook outputs', () => {
  const fixture = createClaimedDispatch(['plugins/sidequest/src/lib/store/tickets.ts', 'plugins/sidequest/src/hooks/shared/paths.ts']);
  const requested = ['plugins/sidequest/lib/other.js', 'plugins/sidequest/lib/store/tickets.js', 'plugins/sidequest/hooks/shared/paths.js'] as const;
  trackBuildFiles(fixture, [requested[0], requested[2]]);

  const result = fixture.store.requestScope(fixture.project, fixture.ticket.ref, 'scope-evidence-worker', requested);
  assert.equal(result.state, 'refused');
  assert.deepEqual(result.approved, []);
  assert.deepEqual(result.refused, requested);
  assert.doesNotMatch(result.comment.body, /build output of/);
});

test('scopeRequest refuses a foreign fragment and names its board ticket owner', () => {
  const fixture = createClaimedDispatch();
  const owner = fixture.store.createTicket(fixture.project, { title: 'Own the other release note', category: 'debugging', files: ['README.md'] });
  const fragment = '.release/unreleased/' + owner.ref + '.md';
  const result = fixture.store.requestScope(fixture.project, fixture.ticket.ref, 'scope-evidence-worker', [fragment]);

  assert.equal(result.state, 'refused');
  assert.deepEqual(result.approved, []);
  assert.deepEqual(result.refused, [fragment]);
  assert.ok(result.message.includes('is owned by ' + owner.ref + ' (' + owner.title + ')'));
  assert.ok(result.comment.body.includes('is owned by ' + owner.ref));
  assert.equal(fixture.store.getTicket(fixture.project, fixture.ticket.ref).files.includes(fragment), false);
});
