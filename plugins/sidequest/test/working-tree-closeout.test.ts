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

test('manual squash delivery with partial quality gaps files debt without the candidate release fragment', () => {
  const { project, slug, git, write } = fixture();
  const previousHome = process.env.SIDEQUEST_CLAUDE_HOME;
  const gateHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-closeout-quality-'));
  try {
    const gate = path.join(gateHome, 'gate');
    fs.mkdirSync(path.join(gateHome, 'plugins'), { recursive: true });
    fs.mkdirSync(path.join(gate, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(gate, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(gate, 'lib', 'core.mjs'), '');
    fs.writeFileSync(path.join(gateHome, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: {
      'quality-gate@eigenwise-toolshed': [{ scope: 'project', projectPath: project, installPath: gate }],
    } }));
    const missing = { relativePath: 'source.js', name: 'missingBody', complexity: 2, classification: 'new', unverified: 'no authentic executed source map' };
    const covered = { relativePath: 'source.js', name: 'coveredBody', complexity: 1, classification: 'new', crap: 1 };
    fs.writeFileSync(path.join(gate, 'bin', 'quality-gate.js'), 'process.stdout.write(' + JSON.stringify(JSON.stringify({ changedMetrics: [missing, covered], unverified: [missing], failures: [] })) + ');');
    process.env.SIDEQUEST_CLAUDE_HOME = gateHome;
    const category = store.getCategory('codebase-exploration');
    store.setCategory({ ...category, route: { model: 'sonnet', effort: 'medium' }, fallback: null });
    const ticket = store.createTicket(slug, {
      title: 'Manual quality debt delivery', category: 'codebase-exploration', files: ['source.js'],
      executorVerifyKind: 'command', executorVerify: 'node -e "process.exit(0)"', source: 'test',
    });
    git(['checkout', '-b', 'candidate']);
    write('source.js', 'function missingBody() { return true; }');
    const fragment = '.release/unreleased/' + ticket.ref + '.md';
    write(fragment, 'Candidate release');
    git(['add', '--', 'source.js', fragment]);
    git(['-c', 'user.name=Sidequest Tests', '-c', 'user.email=sidequest@example.invalid', 'commit', '--quiet', '-m', 'candidate']);
    const candidate = git(['rev-parse', 'HEAD']).toString().trim();
    const gitRef = 'refs/sidequest/' + ticket.ref;
    git(['update-ref', gitRef, candidate]);
    const target = store.integrationTarget(slug);
    const range = require('../lib/commit-scope.js').submissionRange(project, { commit: candidate, gitRef, upstream: target.upstream, integrationBranch: target.branch });
    assert.equal(range.ok, true, JSON.stringify(range));
    assert.equal(store.claimTicket(slug, ticket.ref, 'quality-worker', { direct: true, reason: 'Local direct claim for manual delivery regression.' }).ok, true);
    execFileSync(process.execPath, [path.resolve(__dirname, '../lib/verify-capture.js'), '--project', project, '--ticket', ticket.ref], { cwd: project, env: process.env, windowsHide: true });
    const submitted = store.submitTicket(slug, ticket.ref, 'quality-worker', { commit: candidate, gitRef, range, worktree: project, verify: 'node -e "process.exit(0)"' });
    assert.equal(submitted.ok, true, JSON.stringify(submitted));
    git(['checkout', 'main']);
    git(['merge', '--squash', 'candidate']);
    git(['-c', 'user.name=Sidequest Tests', '-c', 'user.email=sidequest@example.invalid', 'commit', '--quiet', '-m', 'squash landing']);
    const delivery = git(['rev-parse', 'HEAD']).toString().trim();
    const recorded = store.recordDeliveredSubmission(slug, ticket.ref, { target, deliveryCommit: delivery, deliveryMethod: 'manual', by: 'orchestrator', reason: 'Candidate landed as a squash commit with unchanged source and release bytes.' });
    assert.equal(recorded.ok, true, JSON.stringify(recorded));
    assert.equal(recorded.ticket.submission.integration.outcome, 'verified');
    const debts = store.listTickets(slug).filter((entry: { source: string }) => entry.source === 'integration-quality');
    assert.equal(debts.length, 1);
    assert.deepEqual(debts[0].files, ['source.js']);
  } finally {
    if (previousHome === undefined) delete process.env.SIDEQUEST_CLAUDE_HOME;
    else process.env.SIDEQUEST_CLAUDE_HOME = previousHome;
    fs.rmSync(gateHome, { recursive: true, force: true });
  }
});
