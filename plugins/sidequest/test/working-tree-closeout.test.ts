import './_temp-cleanup.js';
import './_sidequest-install-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

process.env.SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-closeout-home-'));
const store = require('../lib/store.js');
store.setCategory({ id: 'closeout-write', name: 'Closeout write', route: { model: 'sonnet', effort: 'medium' }, artifactRoots: [] });

function fixture() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-closeout-project-'));
  const git = (argumentsList: string[]) => execFileSync('git', argumentsList, { cwd: project, windowsHide: true });
  git(['init', '-b', 'main', '--quiet']);
  git(['-c', 'user.name=Sidequest Tests', '-c', 'user.email=sidequest@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'fixture']);
  const { slug } = store.ensureProject(project);
  const create = (file: string) => {
    const ticket = store.createTicket(slug, {
      title: `Deliver ${file}`, category: 'closeout-write', files: [file], workingTreeDelivery: true,
      executorVerifyKind: 'document', executorVerify: 'Read the document.', source: 'mcp',
    });
    const prepared = store.prepareDispatch(slug, ticket.ref, { sharedTree: true, sessionId: path.basename(project) });
    const claimed = store.claimTicket(slug, ticket.ref, `${path.basename(project)}-${file}`, { token: prepared.token, executor: prepared.ticket.dispatchExecutor, source: 'mcp' });
    assert.equal(claimed.ok, true, JSON.stringify(claimed));
    return ticket.ref;
  };
  const write = (file: string, content: string) => {
    const output = path.join(project, file);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, content);
  };
  const close = (reference: string, owner: string) => store.completeTicket(slug, reference, `${path.basename(project)}-${owner}`, { source: 'mcp', verify: 'Read the document.' });
  return { project, slug, git, create, write, close };
}

test('sibling and parent dirt are ignored, returned, and persisted without touching their bytes', () => {
  const { project, slug, create, write, close } = fixture();
  const current = create('current.md');
  create('sibling.md');
  write('current.md', 'Current');
  write('sibling.md', 'Sibling');
  write('parent.md', 'Parent');
  const result = close(current, 'current.md');
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(result.ignoredDirtyPaths, ['parent.md', 'sibling.md']);
  assert.deepEqual(store.getTicket(slug, current).completion.ignoredDirtyPaths, result.ignoredDirtyPaths);
  assert.deepEqual(result.ticket.completion.workingTree.changedPaths, ['current.md']);
  assert.equal(fs.readFileSync(path.join(project, 'sibling.md'), 'utf8'), 'Sibling');
  assert.equal(fs.readFileSync(path.join(project, 'parent.md'), 'utf8'), 'Parent');
});

test('own declared dirt and release fragment remain the delivered candidate', () => {
  const { create, write, close } = fixture();
  const current = create('current.md');
  const fragment = `.release/unreleased/${current}.md`;
  write('current.md', 'Current');
  write(fragment, 'Release');
  write('.release/unreleased/OTHER.md', 'Other release');
  const result = close(current, 'current.md');
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(result.ticket.completion.workingTree.changedPaths, [fragment, 'current.md']);
  assert.deepEqual(result.ignoredDirtyPaths, ['.release/unreleased/OTHER.md']);
});

test('drifted completed sibling warns by name while own delivery closes', () => {
  const { slug, create, write, close } = fixture();
  const sibling = create('sibling.md');
  const current = create('current.md');
  write('sibling.md', 'Sibling');
  assert.equal(close(sibling, 'sibling.md').ok, true);
  write('sibling.md', 'Changed sibling');
  write('current.md', 'Current');
  const result = close(current, 'current.md');
  assert.equal(result.ok, true, result.message);
  assert.equal(result.warnings.length, 1);
  assert.ok(result.warnings[0].includes(sibling));
  assert.deepEqual(store.getTicket(slug, current).completion.warnings, result.warnings);
  assert.deepEqual(result.ignoredDirtyPaths, ['sibling.md']);
});

test('own committed deliverable is still refused and retained', () => {
  const { project, create, write, git, close } = fixture();
  const current = create('current.md');
  write('current.md', 'Current');
  git(['add', '--', 'current.md']);
  git(['-c', 'user.name=Sidequest Tests', '-c', 'user.email=sidequest@example.invalid', 'commit', '--quiet', '-m', 'Own committed delivery']);
  const result = close(current, 'current.md');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'working_tree_commit_forbidden');
  assert.equal(fs.readFileSync(path.join(project, 'current.md'), 'utf8'), 'Current');
});

test('outside dirt cannot replace an empty own deliverable', () => {
  const { create, write, close } = fixture();
  const current = create('current.md');
  write('parent.md', 'Parent');
  const result = close(current, 'current.md');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'working_tree_delivery_empty');
});


test('manual delivery records both commits of a reachable submitted range', () => {
  const { slug, git, write } = fixture();
  store.setBoardConfig(slug, { integrationMode: 'local', integrationBranch: 'main' });
  const base = git(['rev-parse', 'HEAD']).toString().trim();
  write('first.md', 'First commit');
  git(['add', 'first.md']);
  git(['-c', 'user.name=Sidequest Tests', '-c', 'user.email=sidequest@example.invalid', 'commit', '--quiet', '-m', 'first']);
  const first = git(['rev-parse', 'HEAD']).toString().trim();
  write('second.md', 'Second commit');
  git(['add', 'second.md']);
  git(['-c', 'user.name=Sidequest Tests', '-c', 'user.email=sidequest@example.invalid', 'commit', '--quiet', '-m', 'second']);
  const candidate = git(['rev-parse', 'HEAD']).toString().trim();
  const ticket = store.createTicket(slug, { title: 'Two-commit manual delivery', files: ['first.md', 'second.md'] });
  const gitRef = 'refs/sidequest/' + ticket.ref;
  git(['update-ref', gitRef, candidate]);
  ticket.status = 'doing';
  ticket.submission = {
    commit: candidate, base, gitRef, commits: [first, candidate],
    upstream: 'main', upstreamCommit: base, integrationMode: 'local', integrationBranch: 'main',
    admittedScope: ['first.md', 'second.md'], changedPaths: ['first.md', 'second.md'],
    verify: 'node -e "process.exit(0)"', integratedAt: null,
  };
  const database = require('../lib/db.js');
  database.putRow(database.openDb(process.env.SIDEQUEST_HOME), 'tickets', {
    id: ticket.id, project: slug, ref: ticket.ref, status: ticket.status,
    archived: 0, ord: ticket.order, claim_by: null, data: ticket,
  });
  const result = store.completeTicketAsControlPlane(slug, ticket.ref, {
    by: 'integrator', purpose: 'delivery', deliveryCommit: candidate,
    reason: 'Both submitted commits reached main.',
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(store.getTicket(slug, ticket.ref).submission.integration.deliveredFiles, ['first.md', 'second.md']);
});
