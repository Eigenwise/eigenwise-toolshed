import './_temp-cleanup.js';
import './_sidequest-install-fixture.js';
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-negative-control-merge-home-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;
process.env.CLAUDE_PROJECT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-negative-control-merge-unused-'));

const store = require('../lib/store.js');

const codingNormal = store.getCategory('coding.normal');
store.setCategory(Object.assign({}, codingNormal, { route: { model: 'sonnet', effort: 'medium' }, fallback: null }));

function fixtureProject(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const git = (arguments_: string[]) => execFileSync('git', arguments_, { cwd: dir, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  };
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Sidequest Test']);
  git(['config', 'user.email', 'sidequest-test@example.invalid']);
  write('lib/fixture.js', 'module.exports = 1;\n');
  write('test/fixture.test.js', "test('shared test', () => {\n  shared();\n});\n\ntest('resolution test', () => {\n  resolution();\n});\n");
  git(['add', '.']);
  git(['commit', '-m', 'base']);
  const { slug } = store.ensureProject(dir);
  return { dir, git, write, slug };
}

function claimSharedTree(slug: string, by: string) {
  const ticket = store.createTicket(slug, {
    title: 'negative control merge attribution fixture',
    description: 'Where: negative-control merge fixture. Contract: demand markers only for the candidate\'s own test changes. Verify: inspect completion.',
    category: 'coding.normal',
    files: ['lib', 'test'],
    source: 'test',
  });
  const sessionId = `${ticket.ref}-session`;
  const prepared = store.prepareDispatch(slug, ticket.ref, { sharedTree: true, sessionId });
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    sessionId,
    agentName: prepared.ticket.dispatch.launchName,
    source: 'test',
  }).ok, true);
  assert.equal(store.claimTicket(slug, ticket.ref, by, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    sessionId,
    source: 'test',
  }).ok, true);
  return ticket;
}

const control = '[sidequest:negative-control] target=lib/fixture.js:1; assertion=fixture returns the changed value; npm run test:files test/own.test.js failed=1 failure-kind=assertion';

test('GH-160: a merge on the candidate history demands markers only for its own tests and its conflict resolution', () => {
  const { git, write, slug } = fixtureProject('sq-negative-control-merge-');
  const by = 'merge-attribution-executor';
  const ticket = claimSharedTree(slug, by);

  write('lib/fixture.js', 'module.exports = 2;\n');
  write('test/own.test.js', "test('own change test', () => {\n  own();\n});\n");
  git(['add', '.']);
  git(['commit', '-m', 'own work']);

  git(['checkout', '-b', 'other', 'HEAD~1']);
  write('test/other.test.js', "test('other ticket test', () => {\n  other();\n});\n");
  write('test/fixture.test.js', "test('shared test', () => {\n  sharedByOtherTicket();\n});\n\ntest('resolution test', () => {\n  resolution();\n});\n");
  git(['add', '.']);
  git(['commit', '-m', 'another ticket']);
  git(['checkout', 'main']);
  git(['merge', '--no-edit', 'other']);

  assert.equal(store.addComment(slug, ticket.ref, { by, body: `${control}\n[sidequest:negative-control-test] failed own change test`, source: 'mcp' }).ok, true);
  const completion = store.addComment(slug, ticket.ref, { by, body: '[sidequest:verify-complete] passed: fixture verification passed.', source: 'mcp' });
  assert.equal(completion.ok, true, completion.message);

  git(['checkout', '-b', 'third', 'HEAD~1']);
  write('test/third.test.js', "test('third ticket test', () => {\n  third();\n});\n");
  git(['add', '.']);
  git(['commit', '-m', 'third ticket']);
  git(['checkout', 'main']);
  git(['merge', '--no-commit', '--no-ff', 'third']);
  write('test/fixture.test.js', "test('shared test', () => {\n  sharedByOtherTicket();\n});\n\ntest('resolution test', () => {\n  resolvedInTheMerge();\n});\n");
  git(['add', '.']);
  git(['commit', '--no-edit']);

  const refusal = store.addComment(slug, ticket.ref, { by, body: '[sidequest:verify-complete] passed: fixture verification passed.', source: 'mcp' });
  assert.equal(refusal.reason, 'negative_control_test_required');
  assert.match(refusal.message, /resolution test/);
  assert.doesNotMatch(refusal.message, /third ticket test|other ticket test|shared test/);
});

test('GH-160: submit attributes tests from its validated range base, not the dispatch base a fast-forward merge moved past', () => {
  const { git, write, slug } = fixtureProject('sq-negative-control-ff-');
  const by = 'fast-forward-attribution-executor';
  const ticket = claimSharedTree(slug, by);

  git(['checkout', '-b', 'delivered', 'HEAD']);
  write('test/delivered.test.js', "test('already delivered ticket test', () => {\n  delivered();\n});\n");
  git(['add', '.']);
  git(['commit', '-m', 'already delivered ticket']);
  const delivered = git(['rev-parse', 'HEAD']);
  git(['checkout', 'main']);
  git(['merge', '--ff-only', 'delivered']);

  write('lib/fixture.js', 'module.exports = 3;\n');
  write('test/own.test.js', "test('own fast-forward test', () => {\n  own();\n});\n");
  git(['add', '.']);
  git(['commit', '-m', 'own work']);
  const candidate = git(['rev-parse', 'HEAD']);
  const range = {
    base: delivered,
    upstream: 'main',
    upstreamCommit: delivered,
    commits: [candidate],
    changedPaths: ['lib/fixture.js', 'test/own.test.js'],
  };

  assert.equal(store.addComment(slug, ticket.ref, { by, body: control, source: 'mcp' }).ok, true);
  const unreported = store.submitTicket(slug, ticket.ref, by, { commit: candidate, range });
  assert.equal(unreported.reason, 'negative_control_test_required');
  assert.match(unreported.message, /own fast-forward test/);
  assert.doesNotMatch(unreported.message, /already delivered ticket test/);

  assert.equal(store.addComment(slug, ticket.ref, { by, body: '[sidequest:negative-control-test] failed own fast-forward test', source: 'mcp' }).ok, true);
  const submitted = store.submitTicket(slug, ticket.ref, by, { commit: candidate, range });
  assert.notEqual(submitted.reason, 'negative_control_test_required', submitted.message);
});
