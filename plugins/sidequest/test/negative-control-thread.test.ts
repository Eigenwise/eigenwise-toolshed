import './_temp-cleanup.js';
import './_sidequest-install-fixture.js';
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-negative-control-thread-home-'));
const PROJECT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-negative-control-thread-project-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;
process.env.CLAUDE_PROJECT_DIR = PROJECT_DIR;

const store = require('../lib/store.js');

function git(arguments_: string[]) {
  return execFileSync('git', arguments_, { cwd: PROJECT_DIR, encoding: 'utf8', windowsHide: true }).trim();
}

git(['init', '-b', 'main']);
git(['config', 'user.name', 'Sidequest Test']);
git(['config', 'user.email', 'sidequest-test@example.invalid']);
fs.mkdirSync(path.join(PROJECT_DIR, 'lib'), { recursive: true });
fs.mkdirSync(path.join(PROJECT_DIR, 'test'), { recursive: true });
fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'fixture.js'), 'module.exports = 1;\n');
fs.writeFileSync(path.join(PROJECT_DIR, 'test', 'fixture.test.js'), 'module.exports = 1;\n');
git(['add', '.']);
git(['commit', '-m', 'base']);

const { slug } = store.ensureProject(PROJECT_DIR);
const codingNormal = store.getCategory('coding.normal');
store.setCategory(Object.assign({}, codingNormal, { route: { model: 'sonnet', effort: 'medium' }, fallback: null }));

function createClaimedMixedChangeTicket(by: string) {
  const ticket = store.createTicket(slug, {
    title: 'negative control thread fixture',
    description: 'Where: negative-control fixture. Contract: accept matching markers from the claim holder. Verify: inspect completion.',
    category: 'coding.normal',
    files: ['lib/fixture.js', 'test/fixture.test.js'],
    source: 'test',
  });
  const prepared = store.prepareDispatch(slug, ticket.ref, { sharedTree: true, sessionId: `${ticket.ref}-session` });
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    sessionId: `${ticket.ref}-session`,
    agentName: prepared.ticket.dispatch.launchName,
    source: 'test',
  }).ok, true);
  assert.equal(store.claimTicket(slug, ticket.ref, by, {
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    sessionId: `${ticket.ref}-session`,
    source: 'test',
  }).ok, true);
  fs.writeFileSync(path.join(PROJECT_DIR, 'lib', 'fixture.js'), 'module.exports = 2;\n');
  return ticket;
}

const matchingTestName = 'sibling ensure retires dead records without deleting replacement worker and proxy records';
const firstControl = `[sidequest:negative-control] target=plugins/model-gateway/lib/process-supervision.js proxy ownership branch; assertion=pidRecordLines in ${matchingTestName}; node --test --test-timeout=120000 --test-name-pattern="sibling ensure retires" test/gateway-process-isolation.test.js failed=1. Disabling proxy ownership added a live proxy retirement line, then the branch was restored.\n[sidequest:negative-control-test] failed ${matchingTestName}`;
const secondControl = '[sidequest:negative-control] target=plugins/model-gateway/lib/process-supervision.js retirement wording; assertion=retired reused guardian message in ensure and stop discard a stale guardian PID without killing its reused process; node --test --test-timeout=120000 --test-name-pattern="ensure and stop discard" test/gateway-process-isolation.test.js failed=1. Restored the explicit retirement wording afterward.\n[sidequest:negative-control-test] failed ensure and stop discard a stale guardian PID without killing its reused process';
const standaloneMarker = `[sidequest:negative-control-test] failed ${matchingTestName}`;

test('negative controls collect claim-holder test markers across the whole thread', () => {
  const by = 'sq-2483-a2e99bb20c82';
  const ticket = createClaimedMixedChangeTicket(by);
  const fixtureTestDefinition = 'test';
  fs.writeFileSync(path.join(PROJECT_DIR, 'test', 'fixture.test.js'), `${fixtureTestDefinition}('${matchingTestName}', () => {});\n`);

  for (const body of [firstControl, secondControl, standaloneMarker]) {
    assert.equal(store.addComment(slug, ticket.ref, { by, body, source: 'mcp' }).ok, true);
  }

  const completion = store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:verify-complete] passed: fixture verification passed.',
    source: 'mcp',
  });
  assert.equal(completion.ok, true, completion.message);

  const unreportedTestName = 'another changed assertion still needs negative-control evidence';
  fs.appendFileSync(path.join(PROJECT_DIR, 'test', 'fixture.test.js'), `${fixtureTestDefinition}('${unreportedTestName}', () => {});\n`);
  const refusal = store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:verify-complete] passed: fixture verification passed.',
    source: 'mcp',
  });
  assert.equal(refusal.reason, 'negative_control_test_required');
  assert.match(refusal.message, new RegExp(unreportedTestName));
  assert.match(refusal.message, new RegExp(standaloneMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const prefixedMarker = `[sidequest:negative-control-test] failed   pidRecordLines in ${unreportedTestName}`;
  assert.equal(store.addComment(slug, ticket.ref, { by, body: prefixedMarker, source: 'mcp' }).ok, true);
  assert.equal(store.addComment(slug, ticket.ref, {
    by,
    body: '[sidequest:verify-complete] passed: fixture verification passed.',
    source: 'mcp',
  }).ok, true);
});
