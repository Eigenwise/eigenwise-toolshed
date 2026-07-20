'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-artifact-lifecycle-home-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;

const store = require('../lib/store.js');

const PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-artifact-lifecycle-project-'));
const { slug } = store.ensureProject(PROJECT);
const exploration = store.getCategory('codebase-exploration');
store.setCategory(Object.assign({}, exploration, { route: { model: 'sonnet', effort: 'medium' }, fallback: null }));

function ticket(title, description) {
  return store.createTicket(slug, {
    title,
    description,
    category: 'codebase-exploration',
    complexity: 2,
    complexityWhy: 'exercise the bounded shared-tree artifact lifecycle',
    files: ['.claude/.codebase-info/'],
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

test('an explicitly marked shared-tree artifact ticket may close with done after writing its scope', () => {
  const created = ticket('write a codebase map', [
    'Map the visible working tree into the declared documentation directory.',
    store.SHARED_TREE_ARTIFACT_MARKER,
  ].join('\n'));
  const prepared = store.prepareDispatch(slug, created.ref, { sharedTree: true });
  assert.strictEqual(prepared.ticket.dispatch.sharedTree, true);
  assert.strictEqual(prepared.ticket.dispatch.artifactMode, true);
  assert.strictEqual(prepared.ticket.dispatch.artifactScope, '.claude/.codebase-info');
  assert.strictEqual(claim(prepared, 'artifact-worker').ok, true);

  const output = path.join(PROJECT, '.claude', '.codebase-info', 'INDEX.md');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, '# Codebase map\n');

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

  const output = path.join(PROJECT, '.claude', '.codebase-info', 'ordinary.md');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, 'uncommitted\n');
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
