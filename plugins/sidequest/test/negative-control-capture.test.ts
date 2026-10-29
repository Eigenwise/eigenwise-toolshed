import './_temp-cleanup.js';
import './_sidequest-install-fixture.js';
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-negative-control-capture-home-'));
const PROJECT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-negative-control-capture-project-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;
process.env.CLAUDE_PROJECT_DIR = PROJECT_DIR;

const store = require('../lib/store.js');
const { completionView } = require('../lib/store/completion.js');
const { failingTestNames } = require('../lib/verify-capture.js');
const WRAPPER = path.resolve(__dirname, '..', 'lib', 'verify-capture.js');

const CHANGED_TEST_NAME = 'fixture returns two';
const VERIFY_COMMAND = 'node check.js';
// The pinned verifier prints TAP the way node --test does, so the wrapper parses the same lines a
// real runner writes: the changed test passes on the candidate and fails on the reverted source.
const CHECK_SCRIPT = [
  "const value = require('./lib/fixture.js');",
  "if (value === 2) { process.stdout.write('TAP version 13\\nok 1 - " + CHANGED_TEST_NAME + "\\n1..1\\n# fail 0\\n'); }",
  "else { process.stdout.write('TAP version 13\\nnot ok 1 - " + CHANGED_TEST_NAME + "\\n1..1\\n# fail 1\\n'); process.exitCode = 1; }",
  '',
].join('\n');

function git(arguments_: string[]) {
  return execFileSync('git', arguments_, { cwd: PROJECT_DIR, encoding: 'utf8', windowsHide: true }).trim();
}

function writeFixture(relativePath: string, content: string) {
  fs.mkdirSync(path.dirname(path.join(PROJECT_DIR, relativePath)), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, relativePath), content);
}

git(['init', '-b', 'main']);
git(['config', 'user.name', 'Sidequest Test']);
git(['config', 'user.email', 'sidequest-test@example.invalid']);
writeFixture('check.js', CHECK_SCRIPT);
writeFixture('lib/fixture.js', 'module.exports = 1;\n');
const FIXTURE_DEFINITION = 'test';
const UNCHANGED_TEST = `${FIXTURE_DEFINITION}('unchanged fixture guard', () => { assert.equal(')', ')'); });\n`;
writeFixture('test/fixture.test.js', UNCHANGED_TEST + `${FIXTURE_DEFINITION}('passing fixture guard', () => { assert.ok(true); });\n`);
git(['add', '.']);
git(['commit', '-m', 'base']);

const { slug } = store.ensureProject(PROJECT_DIR);
const codingNormal = store.getCategory('coding.normal');
store.setCategory(Object.assign({}, codingNormal, { route: { model: 'sonnet', effort: 'medium' }, fallback: null }));

const CLAIM_HOLDER = 'sq-3965-capture-holder';

function createClaimedCandidate() {
  const ticket = store.createTicket(slug, {
    title: 'negative control capture fixture',
    description: 'Where: negative-control capture fixture. Contract: a captured control binds the failure. Verify: node check.js.',
    category: 'coding.normal',
    files: ['lib/fixture.js', 'test/fixture.test.js'],
    executorVerifyKind: 'command',
    executorVerify: VERIFY_COMMAND,
    source: 'test',
  });
  const sessionId = `${ticket.ref}-session`;
  const prepared = store.prepareDispatch(slug, ticket.ref, { sharedTree: true, sessionId });
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    token: prepared.token, executor: prepared.ticket.dispatchExecutor, sessionId, agentName: prepared.ticket.dispatch.launchName, source: 'test',
  }).ok, true);
  assert.equal(store.claimTicket(slug, ticket.ref, CLAIM_HOLDER, {
    token: prepared.token, executor: prepared.ticket.dispatchExecutor, sessionId, source: 'test',
  }).ok, true);
  const definition = 'test';
  writeFixture('lib/fixture.js', 'module.exports = 2;\n');
  writeFixture('test/fixture.test.js', UNCHANGED_TEST + `${definition}('passing fixture guard', () => { assert.equal(1, 1); });\n` + `${definition}('${CHANGED_TEST_NAME}', () => {});\n`);
  git(['add', '.']);
  git(['commit', '-m', 'candidate']);
  return ticket;
}

function runWrapper(ref: string, extra: string[] = []) {
  const run = spawnSync(process.execPath, [WRAPPER, '--project', PROJECT_DIR, '--ticket', ref, ...extra], {
    cwd: PROJECT_DIR, env: process.env, encoding: 'utf8', windowsHide: true,
  });
  const output = `${run.stdout || ''}${run.stderr || ''}`;
  return { status: run.status, output, captureId: output.match(/^capture=([0-9a-f-]+) /m)?.[1] || '' };
}

function revertedControl(ref: string) {
  writeFixture('lib/fixture.js', 'module.exports = 1;\n');
  try {
    return runWrapper(ref, ['--control']);
  } finally {
    git(['checkout', '--', 'lib/fixture.js']);
  }
}

function recordedCapture(ref: string, captureId: string) {
  return store.getTicket(slug, ref).verificationCaptures.find((capture: { id: string }) => capture.id === captureId);
}

function postMarker(ref: string, body: string) {
  assert.equal(store.addComment(slug, ref, { by: CLAIM_HOLDER, body, source: 'mcp' }).ok, true);
}

function verifyComplete(ref: string) {
  postMarker(ref, '[sidequest:negative-control-test] unaffected passing fixture guard: the guard checks unchanged output');
  return store.addComment(slug, ref, { by: CLAIM_HOLDER, body: '[sidequest:verify-complete] passed: node check.js passed on the candidate.', source: 'mcp' });
}

function controlFor(ref: string, candidate = git(['rev-parse', 'HEAD'])) {
  return store.negativeControlResult(store.getTicket(slug, ref), [CHANGED_TEST_NAME], candidate);
}

const ticket = createClaimedCandidate();
const candidateCapture = runWrapper(ticket.ref);
const failingControl = revertedControl(ticket.ref);
const passingControl = runWrapper(ticket.ref, ['--control']);

test('the pinned verifier passes on the clean candidate and records an ordinary capture', () => {
  assert.equal(candidateCapture.status, 0, candidateCapture.output);
  const capture = recordedCapture(ticket.ref, candidateCapture.captureId);
  assert.equal(capture.status, 'passed');
  assert.equal(capture.control, undefined);
});

test('a control over reverted source records the failing test names, bound to HEAD, and the marker reads captured', () => {
  assert.equal(failingControl.status, 0, failingControl.output);
  assert.match(failingControl.output, /^control=failed failures=1$/m);
  assert.match(failingControl.output, new RegExp(`\\[sidequest:negative-control\\] capture=${failingControl.captureId}`));
  const capture = recordedCapture(ticket.ref, failingControl.captureId);
  assert.deepEqual({ control: capture.control, kind: capture.kind, status: capture.status, controlOutcome: capture.controlOutcome, failures: capture.failures, failingTests: capture.failingTests, command: capture.command, dirtyPaths: capture.dirtyPaths },
    { control: true, kind: 'negative-control', status: 'failed_suite', controlOutcome: 'failed', failures: 1, failingTests: [CHANGED_TEST_NAME], command: VERIFY_COMMAND, dirtyPaths: ['lib/fixture.js'] });
  assert.equal(capture.candidate.value, git(['rev-parse', 'HEAD']));
  assert.equal(capture.exitCode, 1);

  postMarker(ticket.ref, `[sidequest:negative-control] capture=${failingControl.captureId}`);
  assert.deepEqual(controlFor(ticket.ref), { kind: 'failed', evidence: 'captured', captureId: failingControl.captureId });
  const completion = verifyComplete(ticket.ref);
  assert.equal(completion.ok, true, completion.message);

  const view = completionView(store.getTicket(slug, ticket.ref), { negativeControl: controlFor(ticket.ref) });
  assert.deepEqual(view.facts.negativeControl, { kind: `capture(${failingControl.captureId})`, evidence: 'captured' });
});

test('a control capture that bound another commit is refused by name', () => {
  postMarker(ticket.ref, `[sidequest:negative-control] capture=${failingControl.captureId}`);
  assert.equal(controlFor(ticket.ref, '0'.repeat(40)).kind, 'capture_candidate_mismatch');
});

test('a control with zero failures is recorded as control_passed_unexpectedly and never as a passing capture', () => {
  assert.equal(passingControl.status, 2, passingControl.output);
  assert.match(passingControl.output, /^control=control_passed_unexpectedly failures=0$/m);
  const capture = recordedCapture(ticket.ref, passingControl.captureId);
  assert.equal(capture.status, 'failed_check');
  assert.equal(capture.controlOutcome, 'control_passed_unexpectedly');

  postMarker(ticket.ref, `[sidequest:negative-control] capture=${passingControl.captureId}`);
  assert.equal(controlFor(ticket.ref).kind, 'control_passed_unexpectedly');
  const refusal = verifyComplete(ticket.ref);
  assert.equal(refusal.reason, 'negative_control_passed_unexpectedly');
  assert.match(refusal.message, /captured control run passed/);
});

test('a capture id naming a passing verifier capture rather than a control is refused with a named reason', () => {
  postMarker(ticket.ref, `[sidequest:negative-control] capture=${candidateCapture.captureId}`);
  assert.equal(controlFor(ticket.ref).kind, 'capture_not_control');
  const refusal = verifyComplete(ticket.ref);
  assert.equal(refusal.reason, 'negative_control_capture_not_control');
  assert.match(refusal.message, /not run with --control/);
  assert.match(refusal.message, /--control/);
});

test('a marker that names no capture keeps its validation and reads agent-reported', () => {
  postMarker(ticket.ref, `[sidequest:negative-control] target=lib/fixture.js value; assertion=${CHANGED_TEST_NAME}; node check.js failed=1 failure-kind=assertion\n[sidequest:negative-control-test] failed ${CHANGED_TEST_NAME}`);
  assert.deepEqual(controlFor(ticket.ref), { kind: 'failed', evidence: 'agent-reported' });
  assert.equal(verifyComplete(ticket.ref).ok, true);
  const view = completionView(store.getTicket(slug, ticket.ref), { negativeControl: controlFor(ticket.ref) });
  assert.deepEqual(view.facts.negativeControl, { kind: 'marker', evidence: 'agent-reported' });
});

test('a waived control stays waived', () => {
  postMarker(ticket.ref, '[sidequest:negative-control] waived the fixture source cannot be reverted without breaking its import');
  assert.deepEqual(controlFor(ticket.ref), { kind: 'waived', evidence: 'waived' });
  assert.equal(verifyComplete(ticket.ref).ok, true);
});

test('failing test names come from TAP and spec lines, skipping TODO directives and file-level load failures', () => {
  const output = [
    'TAP version 13',
    'not ok 1 - adds two numbers',
    '    not ok 2 - nested \\# hash case',
    'not ok 3 - pending idea # TODO later',
    'not ok 4 - test/broken.test.ts',
    'ok 5 - passes',
    '✖ spec style failure (1.25ms)',
    '✖ failing tests:',
    '✖ adds two numbers (0.5ms)',
  ].join('\n');
  assert.deepEqual(failingTestNames(output), ['adds two numbers', 'nested # hash case', 'spec style failure']);
});

function controlWithNotes(notes: string[], author = CLAIM_HOLDER) {
  const current = store.getTicket(slug, ticket.ref);
  return store.negativeControlResult({
    ...current,
    comments: [{ by: CLAIM_HOLDER, body: `[sidequest:negative-control] capture=${failingControl.captureId}` },
      { by: author, body: notes.join('\n') }],
  }, [CHANGED_TEST_NAME, 'unchanged fixture guard'], git(['rev-parse', 'HEAD']));
}

test('SQ-3999: a captured control records an identical unaffected test with its reason', () => {
  const result = controlWithNotes(['[sidequest:negative-control-test] unaffected unchanged fixture guard: existing assertion passes on both trees']);
  assert.equal(result.kind, 'failed');
  assert.equal(result.evidence, 'captured');
  assert.deepEqual(result.unaffectedTests, [{ name: 'unchanged fixture guard', reason: 'existing assertion passes on both trees', classification: 'unaffected_verified_identical' }]);
});

test('SQ-3999: a genuinely changed passing guard keeps its agent-reported reason alongside captured failures', () => {
  const current = store.getTicket(slug, ticket.ref);
  const result = store.negativeControlResult({ ...current, comments: [
    { by: CLAIM_HOLDER, body: `[sidequest:negative-control] capture=${failingControl.captureId}\n[sidequest:negative-control-test] unaffected passing fixture guard because the changed guard checks unchanged output` },
  ] }, [CHANGED_TEST_NAME, 'passing fixture guard'], git(['rev-parse', 'HEAD']));
  assert.equal(result.kind, 'failed');
  assert.equal(result.evidence, 'captured');
  assert.deepEqual(result.unaffectedTests, [{ name: 'passing fixture guard', reason: 'the changed guard checks unchanged output', classification: 'unaffected_agent_reported' }]);
});

test('SQ-3999: unaffected notes need a reason and the claim holder as author', () => {
  const accepted = controlWithNotes(['[sidequest:negative-control-test] unaffected unchanged fixture guard: the assertion is unchanged']);
  assert.equal(accepted.kind, 'failed');
  const missingReason = controlWithNotes(['[sidequest:negative-control-test] unaffected unchanged fixture guard: ']);
  assert.equal(missingReason.kind, 'capture_tests_uncovered');
  const wrongAuthor = controlWithNotes(['[sidequest:negative-control-test] unaffected unchanged fixture guard: passes on both trees'], 'other-holder');
  assert.equal(wrongAuthor.kind, 'capture_tests_uncovered');
});
