'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-artifact-lifecycle-home-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;

const store = require('../lib/store.js');

const PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-artifact-lifecycle-project-'));
execFileSync('git', ['init', '--quiet'], { cwd: PROJECT, windowsHide: true });
const { slug } = store.ensureProject(PROJECT);
const exploration = store.getCategory('codebase-exploration');
store.setCategory(Object.assign({}, exploration, { route: { model: 'sonnet', effort: 'medium' }, fallback: null }));

function ticket(title, description, files) {
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

function claim(prepared, by) {
  return store.claimTicket(slug, prepared.ticket.ref, by, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    source: 'mcp',
  });
}

function writeProjectFile(relativePath, body) {
  const output = path.join(PROJECT, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, body);
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
  assert.strictEqual(prepared.ticket.dispatch.artifactScope, '.claude/.codebase-info');
  assert.deepStrictEqual(prepared.ticket.dispatch.declaredFiles, ['.claude/.codebase-info']);
  assert.ok(prepared.ticket.dispatch.artifactDirtyBaseline.includes('pre-existing-local.txt'));
  assert.strictEqual(claim(prepared, 'artifact-worker').ok, true);

  writeProjectFile('.claude/.codebase-info/INDEX.md', '# Codebase map\n');

  const done = store.completeTicket(slug, created.ref, 'artifact-worker', { source: 'mcp' });
  assert.strictEqual(done.ok, true);
  assert.strictEqual(done.ticket.status, 'done');
  assert.strictEqual(done.ticket.submission == null, true);
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
  assert.match(done.message, /Commit and submit verified changes/);
  assert.strictEqual(store.getTicket(slug, created.ref).claim.by, 'ordinary-worker');
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
