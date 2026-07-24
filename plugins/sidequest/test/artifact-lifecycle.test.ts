'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-artifact-lifecycle-home-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;

const store = require('../lib/store.js');

const BIN = path.join(__dirname, '..', 'bin', 'sidequest.js');
const PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-artifact-lifecycle-project-'));
execFileSync('git', ['init', '--quiet'], { cwd: PROJECT, windowsHide: true });
execFileSync('git', ['-c', 'user.name=Sidequest Tests', '-c', 'user.email=sidequest@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'fixture'], { cwd: PROJECT, windowsHide: true });
const { slug } = store.ensureProject(PROJECT);
const exploration = store.getCategory('codebase-exploration');
store.setCategory(Object.assign({}, exploration, { route: { model: 'sonnet', effort: 'medium' }, fallback: null }));

function ticket(title: any, description: any, files?: any) {
  return store.createTicket(slug, {
    title,
    description,
    category: 'codebase-exploration',
    complexity: 2,
    complexityWhy: 'exercise the bounded shared-tree artifact lifecycle',
    files: files === undefined ? ['.claude/.codebase-info/'] : files,
    source: 'mcp',
  });
}

function claim(prepared: any, by: any) {
  return store.claimTicket(slug, prepared.ticket.ref, by, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    source: 'mcp',
  });
}

function runCli(args: any) {
  const result = spawnSync(process.execPath, [BIN, ...args, '--project', PROJECT], {
    cwd: PROJECT,
    encoding: 'utf8',
    env: Object.assign({}, process.env, { SIDEQUEST_HOME }),
  });
  return {
    status: result.status,
    output: `${result.stdout || ''}${result.stderr || ''}`,
  };
}

function writeProjectFile(relativePath: string, body: string) {
  const output = path.join(PROJECT, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, body);
}

function preparedArtifact(title: string, by: string) {
  const created = ticket(title, store.SHARED_TREE_ARTIFACT_MARKER);
  const prepared = store.prepareDispatch(slug, created.ref, { sharedTree: true });
  assert.strictEqual(claim(prepared, by).ok, true);
  return created;
}

function assertArtifactPathRejected(created: any, by: string, relativePath: string) {
  const done = store.completeTicket(slug, created.ref, by, { source: 'mcp' });
  assert.strictEqual(done.ok, false);
  assert.strictEqual(done.reason, 'artifact_scope_violation');
  assert.deepStrictEqual(done.unscopedPaths, [relativePath]);
  assert.match(done.message, new RegExp(relativePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

test('an explicitly marked shared-tree artifact ticket may close with done after writing its scope', () => {
  writeProjectFile('pre-existing-local.txt', 'caller dirt\n');
  const created = ticket('write a codebase map', [
    'Map the visible working tree into the declared documentation directory.',
    store.SHARED_TREE_ARTIFACT_MARKER,
  ].join('\n'));
  const prepared = store.prepareDispatch(slug, created.ref, { sharedTree: true });
  assert.strictEqual(prepared.ticket.dispatch.sharedTree, true);
  assert.strictEqual(prepared.ticket.dispatch.artifactMode, true);
  assert.strictEqual(prepared.ticket.dispatch.artifactRoot, '.claude/.codebase-info');
  assert.strictEqual(prepared.ticket.dispatch.artifactScope, '.claude/.codebase-info');
  assert.deepStrictEqual(prepared.ticket.dispatch.declaredFiles, ['.claude/.codebase-info']);
  assert.ok(prepared.ticket.dispatch.artifactDirtyBaseline.some((entry: any) => entry.path === 'pre-existing-local.txt' && /^[a-f0-9]{64}$/.test(entry.identity)));
  assert.strictEqual(claim(prepared, 'artifact-worker').ok, true);

  writeProjectFile('.claude/.codebase-info/INDEX.md', '# Codebase map\n');

  const done = store.completeTicket(slug, created.ref, 'artifact-worker', { source: 'mcp' });
  assert.strictEqual(done.ok, true);
  assert.strictEqual(done.ticket.status, 'done');
  assert.strictEqual(done.ticket.submission == null, true);
});

test('artifact completion permits untouched pre-existing dirt', () => {
  const relativePath = 'untouched-caller-dirt.txt';
  writeProjectFile(relativePath, 'untouched caller dirt\n');
  const created = preparedArtifact('preserve untouched caller dirt', 'untouched-dirt-worker');
  writeProjectFile('.claude/.codebase-info/untouched.md', '# Generated map\n');

  const done = store.completeTicket(slug, created.ref, 'untouched-dirt-worker', { source: 'mcp' });
  assert.strictEqual(done.ok, true);
});

test('artifact completion refuses modified pre-existing dirt', () => {
  const relativePath = 'modified-caller-dirt.txt';
  writeProjectFile(relativePath, 'before dispatch\n');
  const created = preparedArtifact('detect modified caller dirt', 'modified-dirt-worker');
  writeProjectFile(relativePath, 'after dispatch\n');

  assertArtifactPathRejected(created, 'modified-dirt-worker', relativePath);
});

test('artifact completion refuses deleted pre-existing dirt', () => {
  const relativePath = 'deleted-caller-dirt.txt';
  writeProjectFile(relativePath, 'before dispatch\n');
  const created = preparedArtifact('detect deleted caller dirt', 'deleted-dirt-worker');
  fs.unlinkSync(path.join(PROJECT, relativePath));

  assertArtifactPathRejected(created, 'deleted-dirt-worker', relativePath);
});

test('artifact completion refuses replaced pre-existing dirt', () => {
  const relativePath = 'replaced-caller-dirt.txt';
  const absolutePath = path.join(PROJECT, relativePath);
  writeProjectFile(relativePath, 'before dispatch\n');
  const created = preparedArtifact('detect replaced caller dirt', 'replaced-dirt-worker');
  fs.unlinkSync(absolutePath);
  writeProjectFile(relativePath, 'replacement\n');

  assertArtifactPathRejected(created, 'replaced-dirt-worker', relativePath);
});

test('artifact completion refuses restaged pre-existing dirt', () => {
  const relativePath = 'restaged-caller-dirt.txt';
  writeProjectFile(relativePath, 'staged before dispatch\n');
  execFileSync('git', ['add', '--', relativePath], { cwd: PROJECT, windowsHide: true });
  const created = preparedArtifact('detect restaged caller dirt', 'restaged-dirt-worker');
  writeProjectFile(relativePath, 'staged after dispatch\n');
  execFileSync('git', ['add', '--', relativePath], { cwd: PROJECT, windowsHide: true });

  assertArtifactPathRejected(created, 'restaged-dirt-worker', relativePath);
});

test('ordinary scoped tickets still require commit and submit even in the shared tree', () => {
  const created = ticket('ordinary repository edit', 'Change the declared repository files.');
  const prepared = store.prepareDispatch(slug, created.ref, { sharedTree: true });
  assert.strictEqual(prepared.ticket.dispatch.artifactMode, false);
  assert.strictEqual(claim(prepared, 'ordinary-worker').ok, true);

  writeProjectFile('.claude/.codebase-info/ordinary.md', 'uncommitted\n');
  const done = store.completeTicket(slug, created.ref, 'ordinary-worker', { source: 'mcp' });

  assert.strictEqual(done.ok, false);
  assert.strictEqual(done.reason, 'submission_required');
  assert.match(done.message, /commit and submit verified changes/i);
  assert.strictEqual(store.getTicket(slug, created.ref).claim.by, 'ordinary-worker');
});

test('read-only dispatches with external output may close with done', () => {
  const outside = path.join(os.tmpdir(), `sq-external-audition-${process.pid}.html`);
  const created = ticket('external HTML audition', 'Write an external HTML audition.', [outside]);
  const prepared = store.prepareDispatch(slug, created.ref, { sharedTree: false });
  assert.strictEqual(prepared.ticket.dispatch.nonRepoOutput, true);
  assert.strictEqual(claim(prepared, 'external-output-worker').ok, true);

  fs.writeFileSync(outside, '<main>audition</main>\n');
  const done = store.completeTicket(slug, created.ref, 'external-output-worker', { source: 'mcp' });

  assert.strictEqual(done.ok, true);
  assert.strictEqual(done.ticket.status, 'done');
  assert.strictEqual(done.ticket.submission == null, true);
});

test('repository-category external output still requires submission', () => {
  store.setCategory({
    id: 'repository-external-output',
    name: 'Repository external output',
    route: { model: 'sonnet', effort: 'medium' },
    artifactRoots: [],
  });
  const outside = path.join(os.tmpdir(), `sq-repository-external-${process.pid}.html`);
  const created = store.createTicket(slug, {
    title: 'repository external output',
    description: 'Write external output from a repository-changing category.',
    category: 'repository-external-output',
    files: [outside],
    source: 'mcp',
  });
  const prepared = store.prepareDispatch(slug, created.ref, { sharedTree: false });
  assert.strictEqual(prepared.ticket.dispatch.nonRepoOutput, undefined);
  assert.strictEqual(claim(prepared, 'repository-external-worker').ok, true);

  const done = store.completeTicket(slug, created.ref, 'repository-external-worker', { source: 'mcp' });

  assert.strictEqual(done.ok, false);
  assert.strictEqual(done.reason, 'submission_required');
  assert.match(done.message, /release it for reclassification as non-repo\/artifact work/i);
});

test('the artifact marker alone does not bypass submit from an isolated dispatch', () => {
  const created = ticket('isolated artifact attempt', store.SHARED_TREE_ARTIFACT_MARKER);
  const prepared = store.prepareDispatch(slug, created.ref, { sharedTree: false });
  assert.strictEqual(prepared.ticket.dispatch.artifactMode, false);
  assert.strictEqual(claim(prepared, 'isolated-worker').ok, true);

  const done = store.completeTicket(slug, created.ref, 'isolated-worker', { source: 'mcp' });
  assert.strictEqual(done.ok, false);
  assert.strictEqual(done.reason, 'submission_required');
});

test('marker text cannot grant artifact authority to a category or scope', () => {
  store.setCategory({
    id: 'review-audit-artifact-attempt',
    name: 'Review audit artifact attempt',
    route: { model: 'sonnet', effort: 'medium' },
    artifactRoots: [],
  });
  const arbitraryCategory = store.createTicket(slug, {
    title: 'arbitrary category artifact attempt',
    description: store.SHARED_TREE_ARTIFACT_MARKER,
    category: 'review-audit-artifact-attempt',
    files: ['.claude/.codebase-info'],
    source: 'mcp',
  });
  const categoryDispatch = store.prepareDispatch(slug, arbitraryCategory.ref, { sharedTree: true });
  assert.strictEqual(categoryDispatch.ticket.dispatch.artifactMode, false);
  assert.strictEqual(claim(categoryDispatch, 'arbitrary-category-worker').ok, true);
  assert.strictEqual(store.completeTicket(slug, arbitraryCategory.ref, 'spoofed-groomer', { source: 'control-plane-grooming' }).reason, 'submission_required');

  const arbitraryScope = ticket('arbitrary scope artifact attempt', store.SHARED_TREE_ARTIFACT_MARKER, ['src']);
  const scopeDispatch = store.prepareDispatch(slug, arbitraryScope.ref, { sharedTree: true });
  assert.strictEqual(scopeDispatch.ticket.dispatch.artifactMode, false);
  assert.strictEqual(claim(scopeDispatch, 'arbitrary-scope-worker').ok, true);
  assert.strictEqual(store.completeTicket(slug, arbitraryScope.ref, 'arbitrary-scope-worker', { source: 'mcp' }).reason, 'submission_required');
});

test('update status done cannot bypass claimed, dispatched, or submitted lifecycle state', () => {
  const claimed = ticket('claimed scoped work', 'Claimed work must use its executor completion path.');
  const claimedDispatch = store.prepareDispatch(slug, claimed.ref, { sharedTree: false });
  assert.strictEqual(claim(claimedDispatch, 'claimed-worker').ok, true);
  assert.throws(
    () => store.updateTicket(slug, claimed.ref, { status: 'done' }),
    /done\/completeTicket.*commit and submit/
  );

  const dispatched = ticket('dispatched scoped work', 'Prepared work must preserve its dispatch lifecycle.');
  store.prepareDispatch(slug, dispatched.ref, { sharedTree: false });
  assert.throws(
    () => store.updateTicket(slug, dispatched.ref, { status: 'done' }),
    /active dispatch.*done\/completeTicket or commit and submit/
  );

  const submitted = ticket('submitted scoped work', 'Submitted work waits for integration.');
  const submittedDispatch = store.prepareDispatch(slug, submitted.ref, { sharedTree: false });
  assert.strictEqual(claim(submittedDispatch, 'submitted-worker').ok, true);
  assert.strictEqual(store.submitTicket(slug, submitted.ref, 'submitted-worker', {
    commit: 'abcdef0',
    source: 'mcp',
  }).ok, true);
  assert.throws(
    () => store.updateTicket(slug, submitted.ref, { status: 'done' }),
    /pending submission.*integration lifecycle/
  );
});

test('released routed work refuses executor completion and allows explicit control-plane grooming', () => {
  const created = ticket('released scoped work', 'Released routed work keeps its lifecycle authority.');
  const prepared = store.prepareDispatch(slug, created.ref, { sharedTree: false });
  assert.strictEqual(claim(prepared, 'released-worker').ok, true);

  const released = store.releaseTicket(slug, created.ref, 'released-worker', { status: 'todo', source: 'mcp' });
  assert.strictEqual(released.ok, true);
  assert.strictEqual(released.ticket.dispatch.outcome, 'released');
  assert.ok(released.ticket.dispatch.terminalAt);
  assert.strictEqual(released.ticket.dispatchNonce, null);
  assert.throws(
    () => store.updateTicket(slug, created.ref, { status: 'done' }),
    /routed dispatch history.*control-plane grooming closure/
  );

  for (const attempt of [
    store.completeTicket(slug, created.ref, 'released-worker', { source: 'mcp' }),
    store.completeTicket(slug, created.ref, 'board-groomer', { source: 'mcp' }),
    store.completeTicket(slug, created.ref, 'board-groomer', { source: 'control-plane-grooming' }),
  ]) {
    assert.strictEqual(attempt.ok, false);
    assert.strictEqual(attempt.reason, 'submission_required');
  }
  const groomed = store.closeTicketForGrooming(slug, created.ref, {
    by: 'board-groomer',
    reason: 'Verified obsolete against the integrated implementation.',
  });
  assert.strictEqual(groomed.ok, true);
  assert.strictEqual(groomed.ticket.status, 'done');
  assert.strictEqual(groomed.ticket.completion.by, 'board-groomer');
  assert.strictEqual(groomed.ticket.completion.authority, 'control-plane');
  assert.strictEqual(groomed.ticket.completion.purpose, 'grooming');
  assert.strictEqual(groomed.ticket.completion.reason, 'Verified obsolete against the integrated implementation.');
  assert.ok(groomed.ticket.completion.at);
});

test('released routed work refuses CLI update status done', () => {
  const created = ticket('released CLI scoped work', 'CLI updates must keep released dispatch authority.');
  const prepared = store.prepareDispatch(slug, created.ref, { sharedTree: false });
  assert.strictEqual(claim(prepared, 'released-cli-worker').ok, true);
  assert.strictEqual(store.releaseTicket(slug, created.ref, 'released-cli-worker', { status: 'todo', source: 'mcp' }).ok, true);

  const updated = runCli(['update', created.ref, '--status', 'done']);
  assert.notStrictEqual(updated.status, 0);
  assert.match(updated.output, /routed dispatch history.*control-plane grooming closure/);
  assert.strictEqual(store.getTicket(slug, created.ref).status, 'todo');

  const spoofed = runCli(['done', created.ref, '--groom', 'true', '--body', 'Worker tried the old generic completion flag.']);
  assert.notStrictEqual(spoofed.status, 0);
  assert.strictEqual(store.getTicket(slug, created.ref).status, 'todo');

  const missingReason = runCli(['groom-close', created.ref]);
  assert.notStrictEqual(missingReason.status, 0);
  assert.match(missingReason.output, /pass --reason/);

  const groomed = runCli(['groom-close', created.ref, '--reason', 'Verified as already shipped during board grooming.', '--by', 'cli-board-groomer']);
  assert.strictEqual(groomed.status, 0, groomed.output);
  const closed = store.getTicket(slug, created.ref);
  assert.strictEqual(closed.status, 'done');
  assert.strictEqual(closed.completion.by, 'cli-board-groomer');
  assert.strictEqual(closed.completion.reason, 'Verified as already shipped during board grooming.');
});

test('update status done still closes a plain unclaimed and undispatched ticket', () => {
  const created = ticket('administrative closure', 'Close this ticket during ordinary board grooming.');
  const updated = store.updateTicket(slug, created.ref, { status: 'done' });
  assert.strictEqual(updated.status, 'done');
});

test('a claimed ticket cannot be rewritten and redispatched into artifact mode', () => {
  const created = ticket('ordinary claimed ticket', 'Start as ordinary scoped repository work.');
  const prepared = store.prepareDispatch(slug, created.ref, { sharedTree: false });
  assert.strictEqual(claim(prepared, 'rewrite-worker').ok, true);
  store.updateTicket(slug, created.ref, {
    description: store.SHARED_TREE_ARTIFACT_MARKER,
    files: ['.claude/.codebase-info/'],
  });

  assert.throws(
    () => store.prepareDispatch(slug, created.ref, { sharedTree: true }),
    /has a live claim.*Release it before dispatching again/
  );
  assert.strictEqual(store.sharedTreeArtifactMode(store.getTicket(slug, created.ref)), false);
});

test('description and files mutations after dispatch do not flip pinned artifact authority', () => {
  const ordinary = ticket('pinned ordinary dispatch', 'Start without artifact authority.');
  const ordinaryDispatch = store.prepareDispatch(slug, ordinary.ref, { sharedTree: true });
  assert.strictEqual(claim(ordinaryDispatch, 'ordinary-mutation-worker').ok, true);
  store.updateTicket(slug, ordinary.ref, {
    description: store.SHARED_TREE_ARTIFACT_MARKER,
    files: [],
  });
  const mutatedOrdinary = store.getTicket(slug, ordinary.ref);
  assert.strictEqual(store.sharedTreeArtifactMode(mutatedOrdinary), false);
  assert.strictEqual(store.completeTicket(slug, ordinary.ref, 'ordinary-mutation-worker', { source: 'mcp' }).reason, 'submission_required');

  const artifact = ticket('pinned artifact dispatch', store.SHARED_TREE_ARTIFACT_MARKER);
  const artifactDispatch = store.prepareDispatch(slug, artifact.ref, { sharedTree: true });
  assert.strictEqual(claim(artifactDispatch, 'artifact-mutation-worker').ok, true);
  writeProjectFile('.claude/.codebase-info/pinned.md', 'pinned authority\n');
  store.updateTicket(slug, artifact.ref, {
    description: 'The marker was removed after dispatch.',
    files: [],
  });
  const mutatedArtifact = store.getTicket(slug, artifact.ref);
  assert.strictEqual(store.sharedTreeArtifactMode(mutatedArtifact), true);
  assert.strictEqual(store.completeTicket(slug, artifact.ref, 'artifact-mutation-worker', { source: 'mcp' }).ok, true);
});

test('artifact completion refuses filesystem indirection created after dispatch', () => {
  const scope = '.claude/.codebase-info/post-dispatch-link';
  const created = ticket('post-dispatch junction artifact', store.SHARED_TREE_ARTIFACT_MARKER, [scope]);
  const prepared = store.prepareDispatch(slug, created.ref, { sharedTree: true });
  assert.strictEqual(prepared.ticket.dispatch.artifactMode, true);
  assert.strictEqual(claim(prepared, 'junction-worker').ok, true);

  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-artifact-outside-'));
  const link = path.join(PROJECT, ...scope.split('/'));
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  fs.writeFileSync(path.join(link, 'escaped.txt'), 'outside project\n');

  const done = store.completeTicket(slug, created.ref, 'junction-worker', { source: 'mcp' });
  assert.strictEqual(done.ok, false);
  assert.strictEqual(done.reason, 'artifact_scope_indirection');
  assert.deepStrictEqual(done.indirectPaths, [scope]);
  assert.strictEqual(fs.readFileSync(path.join(outside, 'escaped.txt'), 'utf8'), 'outside project\n');
  assert.strictEqual(store.getTicket(slug, created.ref).status, 'doing');
  fs.unlinkSync(link);
});

test('artifact completion refuses a newly dirty path outside the dispatch scope', () => {
  const created = ticket('out of scope artifact', store.SHARED_TREE_ARTIFACT_MARKER);
  const prepared = store.prepareDispatch(slug, created.ref, { sharedTree: true });
  assert.strictEqual(claim(prepared, 'out-of-scope-worker').ok, true);
  writeProjectFile('outside-declared-scope.txt', 'must not survive completion\n');

  const done = store.completeTicket(slug, created.ref, 'out-of-scope-worker', { source: 'mcp' });
  assert.strictEqual(done.ok, false);
  assert.strictEqual(done.reason, 'artifact_scope_violation');
  assert.deepStrictEqual(done.unscopedPaths, ['outside-declared-scope.txt']);
  assert.match(done.message, /Revert those changes or release the ticket/);
  assert.strictEqual(store.getTicket(slug, created.ref).claim.by, 'out-of-scope-worker');
});
