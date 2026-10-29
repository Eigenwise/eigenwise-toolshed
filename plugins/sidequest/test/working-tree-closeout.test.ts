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
  const create = (file: string, { workingTreeDelivery = true, externalDeliverable = false } = {}) => {
    const ticket = store.createTicket(slug, {
      title: `Deliver ${file}`, category: 'closeout-write', files: [file], workingTreeDelivery, externalDeliverable,
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

function linkedWorktree(git: (argumentsList: string[]) => Buffer) {
  const worktree = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-closeout-linked-')), 'linked');
  git(['worktree', 'add', '--quiet', '--detach', worktree]);
  return worktree;
}

function recordDispatchWorktree(slug: string, reference: string, worktree: string) {
  const ticket = store.getTicket(slug, reference);
  ticket.dispatch.worktree = worktree;
  const database = require('../lib/db.js');
  database.putRow(database.openDb(process.env.SIDEQUEST_HOME), 'tickets', {
    id: ticket.id, project: slug, ref: ticket.ref, status: ticket.status,
    archived: 0, ord: ticket.order, claim_by: ticket.claim.by, data: ticket,
  });
}

function sameDirectory(left: string, right: string) {
  return fs.realpathSync.native(left).toLowerCase() === fs.realpathSync.native(right).toLowerCase();
}

test('working-tree delivery done in a linked worktree names both trees, then completes when done names it', () => {
  const { project, slug, git, create, close } = fixture();
  const current = create('current.md');
  const linked = linkedWorktree(git);
  const owner = `${path.basename(project)}-current.md`;
  const closeIn = (worktree: string) => store.completeTicket(slug, current, owner, { source: 'mcp', verify: 'Read the document.', worktree });
  const cleanLinked = closeIn(linked);
  assert.equal(cleanLinked.reason, 'working_tree_delivery_empty');
  assert.doesNotMatch(cleanLinked.message, /The board diffed/);
  fs.writeFileSync(path.join(linked, 'current.md'), 'Linked');
  recordDispatchWorktree(slug, current, linked);
  const refused = close(current, 'current.md');
  assert.equal(refused.reason, 'working_tree_delivery_empty');
  assert.ok(refused.message.includes(`The board diffed ${store.readMeta(slug).path}; your work is in ${linked}`), refused.message);
  assert.match(refused.message, /clear that flag or submit a commit from the worktree; or repeat done with worktree:/);
  const result = closeIn(linked);
  assert.equal(result.ok, true, result.message);
  assert.equal(result.ticket.completion.purpose, 'working-tree');
  assert.deepEqual(result.ticket.completion.workingTree.changedPaths, ['current.md']);
  assert.ok(sameDirectory(result.ticket.completion.workingTree.worktree, linked));
});

test('an empty registered-checkout diff points a shared-tree executor at done worktree, which then diffs that tree', () => {
  const { project, slug, git, create } = fixture();
  const current = create('current.md', { workingTreeDelivery: false });
  const linked = linkedWorktree(git);
  fs.writeFileSync(path.join(linked, 'current.md'), 'Linked');
  const refused = store.completionTreeCheck(slug, store.getTicket(slug, current));
  assert.equal(refused.reason, 'empty_declared_scope');
  assert.ok(refused.message.includes(`The board diffed ${store.readMeta(slug).path}; no other worktree was read`), refused.message);
  assert.match(refused.message, /repeat done with worktree:/);
  const named = store.completeTicket(slug, current, `${path.basename(project)}-current.md`, { source: 'mcp', verify: 'Read the document.', worktree: linked });
  assert.equal(named.reason, 'submission_required', named.message);
});

test('done refuses a worktree outside the project or without the dispatch base', () => {
  const { project, slug, git, create } = fixture();
  const current = create('current.md');
  const owner = `${path.basename(project)}-current.md`;
  const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-closeout-foreign-'));
  execFileSync('git', ['init', '-b', 'main', '--quiet'], { cwd: foreign, windowsHide: true });
  const outside = store.completeTicket(slug, current, owner, { source: 'mcp', verify: 'Read the document.', worktree: foreign });
  assert.equal(outside.reason, 'completion_worktree_unavailable');
  assert.match(outside.message, /is not a worktree of the registered project/);
  const unrelated = linkedWorktree(git);
  execFileSync('git', ['checkout', '--quiet', '--orphan', 'unrelated'], { cwd: unrelated, windowsHide: true });
  execFileSync('git', ['-c', 'user.name=Sidequest Tests', '-c', 'user.email=sidequest@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'unrelated'], { cwd: unrelated, windowsHide: true });
  const baseless = store.completeTicket(slug, current, owner, { source: 'mcp', verify: 'Read the document.', worktree: unrelated });
  assert.equal(baseless.reason, 'completion_worktree_unavailable');
  assert.match(baseless.message, /the dispatch base [0-9a-f]{40} is not in the history of/);
  assert.equal(store.getTicket(slug, current).status, 'doing');
});

test('late working-tree declaration includes already dirty declared paths and preserves its baseline on retry', () => {
  const { slug, create, write, close } = fixture();
  const current = create('current.md', { workingTreeDelivery: false });
  write('current.md', 'Already edited');
  const refused = close(current, 'current.md');
  assert.equal(refused.reason, 'submission_required');
  assert.match(refused.message, /Commit and submit verified changes/);
  const updated = store.updateTicket(slug, current, { workingTreeDelivery: true, by: 'orchestrator' }, undefined, { allowLiveClaimCloseoutUpdate: true });
  assert.equal(updated.dispatch.workingTreeDelivery, true);
  assert.equal(updated.dispatch.workingTreeDirtyBaselineLate, true);
  assert.deepEqual(updated.dispatch.workingTreeDirtyBaseline.map((entry: { path: string }) => entry.path), ['current.md']);
  const repeated = store.updateTicket(slug, current, { workingTreeDelivery: true, by: 'orchestrator' }, undefined, { allowLiveClaimCloseoutUpdate: true });
  assert.equal(repeated.dispatch.workingTreeDeliveryAmendedAt, updated.dispatch.workingTreeDeliveryAmendedAt);
  const result = close(current, 'current.md');
  assert.equal(result.ok, true, result.message);
  assert.equal(result.ticket.completion.purpose, 'working-tree');
  assert.deepEqual(result.ticket.completion.workingTree.changedPaths, ['current.md']);
});

test('stale working-tree declaration guides both external-deliverable refusal paths', () => {
  const { slug, create, write, close } = fixture();
  const current = create('current.md', { workingTreeDelivery: false });
  write('current.md', 'Already edited');
  const ticket = { ...store.getTicket(slug, current), workingTreeDelivery: true };
  const database = require('../lib/db.js');
  database.putRow(database.openDb(process.env.SIDEQUEST_HOME), 'tickets', {
    id: ticket.id, project: slug, ref: ticket.ref, status: ticket.status,
    archived: 0, ord: ticket.order, claim_by: ticket.claim.by, data: ticket,
  });
  const doneRefusal = close(current, 'current.md');
  assert.equal(doneRefusal.reason, 'submission_required');
  assert.match(doneRefusal.message, /update workingTreeDelivery:true/);
  for (const externalDeliverable of [false, true]) {
    const refusal = store.externalDeliverableCloseout(slug, { ...ticket, externalDeliverable }, 'Read the document.');
    assert.equal(refusal.reason, externalDeliverable ? 'external_deliverable_scope_dirty' : 'external_deliverable_not_declared');
    assert.match(refusal.message, /declares workingTreeDelivery:true, but this dispatch was prepared without it/);
    assert.match(refusal.message, /update workingTreeDelivery:true/);
    assert.match(refusal.message, /release and redispatch/);
  }
});

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

test('submit refuses a live working-tree delivery, names done, and leaves the claim to close with done', () => {
  const { project, slug, create, write, close } = fixture();
  const current = create('current.md');
  write('current.md', 'Current');
  const owner = `${path.basename(project)}-current.md`;
  const refused = store.submitTicket(slug, current, owner, { commit: 'abcdef1', worktree: project, verify: 'Read the document.' });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'working_tree_delivery_uses_done');
  assert.match(refused.message, /^submit: refused .*workingTreeDelivery:true.*pass explicit done\.verify evidence, then close with done\.$/);
  assert.equal(store.getTicket(slug, current).claim.by, owner);
  assert.equal(store.getTicket(slug, current).submission, undefined);
  assert.equal(close(current, 'current.md').ok, true);
});

test('commit refusal names the pinned capture for a command working-tree delivery and stops once the dispatch is terminal', () => {
  const { slug, create } = fixture();
  const current = create('current.md');
  const ticket = store.getTicket(slug, current);
  const commandTicket = { ...ticket, dispatch: { ...ticket.dispatch, verificationRequirement: { kind: 'command', command: 'npm test' } } };
  assert.match(store.workingTreeDeliveryCommitRefusal(commandTicket, 'commit').message, /^commit: refused .*run the pinned verify-capture wrapper, then close with done\.$/);
  assert.equal(store.workingTreeDeliveryCommitRefusal({ ...ticket, dispatch: { ...ticket.dispatch, terminalAt: new Date().toISOString() } }, 'commit'), null);
  assert.equal(store.workingTreeDeliveryCommitRefusal({ ...ticket, dispatch: { ...ticket.dispatch, workingTreeDelivery: false } }, 'submit'), null);
});

test('board workingTreeDeliveryCategories stamps new tickets in a listed category at add time', () => {
  const { slug } = fixture();
  const configured = store.setBoardConfig(slug, { workingTreeDeliveryCategories: [' Closeout-Write ', 'closeout-write', ''] });
  assert.deepEqual(configured.config.workingTreeDeliveryCategories, ['closeout-write']);
  const fields = { files: ['docs.md'], executorVerifyKind: 'document', executorVerify: 'Read the document.', source: 'mcp' };
  assert.equal(store.createTicket(slug, { ...fields, title: 'Listed category', category: 'closeout-write' }).workingTreeDelivery, true);
  assert.equal(store.createTicket(slug, { ...fields, title: 'Explicit opt-out', category: 'closeout-write', workingTreeDelivery: false }).workingTreeDelivery, false);
  assert.equal(store.createTicket(slug, { ...fields, title: 'Unlisted category', category: 'general' }).workingTreeDelivery, false);
  assert.equal(store.createTicket(slug, { ...fields, title: 'No category' }).workingTreeDelivery, false);
  assert.throws(() => store.setBoardConfig(slug, { workingTreeDeliveryCategories: 'closeout-write' }), /must be an array of category ids/);
  assert.deepEqual(store.setBoardConfig(slug, { workingTreeDeliveryCategories: null }).config.workingTreeDeliveryCategories, []);
  assert.equal(store.createTicket(slug, { ...fields, title: 'Cleared default', category: 'closeout-write' }).workingTreeDelivery, false);
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

for (const status of ['failed_suite', 'failed_check', 'toolchain_missing', 'could_not_run', 'timeout']) {
  test('clean external deliverable accepts factual ' + status + ' evidence without granting completion', () => {
    const { project, slug, create } = fixture();
    const reference = create('external.md', { workingTreeDelivery: false, externalDeliverable: true });
    const owner = path.basename(project) + '-external.md';
    const body = '[sidequest:verify-complete] ' + status + ': focused check did not succeed before editing.';
    const recorded = store.addComment(slug, reference, { by: owner, body, source: 'mcp' });
    assert.equal(recorded.ok, true, JSON.stringify(recorded));
    assert.equal(recorded.comment.body, body);
    assert.equal(store.getTicket(slug, reference).status, 'doing');
    assert.equal(store.claimMaySubmit(store.getTicket(slug, reference)), false);
    const wrongAuthor = store.addComment(slug, reference, { by: 'another-worker', body, source: 'mcp' });
    assert.equal(wrongAuthor.reason, 'empty_declared_scope');
  });
}

for (const status of ['passed', 'manual', 'attestation', 'skipped']) {
  test('clean external deliverable still refuses ' + status + ' completion', () => {
    const { project, slug, create } = fixture();
    const reference = create('external.md', { workingTreeDelivery: false, externalDeliverable: true });
    const refused = store.addComment(slug, reference, {
      by: path.basename(project) + '-external.md',
      body: '[sidequest:verify-complete] ' + status + ': no scoped changes.', source: 'mcp',
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'empty_declared_scope');
    assert.match(refused.message, /factual failed_suite, failed_check, toolchain_missing, could_not_run, or timeout verification evidence/);
  });
}
