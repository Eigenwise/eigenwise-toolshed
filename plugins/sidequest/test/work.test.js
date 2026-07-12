'use strict';
/** Behavioral regression coverage for SQ-213 native-only routed work. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-work-test-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;
const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'sidequest.js');
const store = require('../lib/store.js');
const work = require('../lib/work.js');
const { slug } = store.ensureProject(path.join(SIDEQUEST_HOME, 'fixture-project'), 'Fixture Project');

function ticket(fields) {
  return store.createTicket(slug, Object.assign({ title: 'fixture', complexity: 1, complexityWhy: 'small behavioral fixture for dispatch tests' }, fields));
}
function result(ref) {
  return work.nativeDispatchRequired(slug, ref);
}
function runCli(args) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: path.join(SIDEQUEST_HOME, 'fixture-project') }),
  });
}

test('nativeDispatchRequired returns missing for unknown tickets', () => {
  assert.deepStrictEqual(result('SQ-999'), { ok: false, reason: 'missing', message: 'no ticket "SQ-999".' });
});

test('nativeDispatchRequired refuses done tickets', () => {
  const t = ticket({ status: 'done' });
  assert.strictEqual(result(t.ref).reason, 'done');
});

test('nativeDispatchRequired refuses non-todo tickets', () => {
  const t = ticket({ status: 'doing' });
  assert.strictEqual(result(t.ref).reason, 'not_todo');
});

test('nativeDispatchRequired refuses claimed tickets', () => {
  const t = ticket();
  const claimed = store.claimTicket(slug, t.ref, 'fixture-worker', { status: false });
  assert.strictEqual(claimed.ok, true);
  assert.strictEqual(result(t.ref).reason, 'claimed');
});

test('nativeDispatchRequired refuses tickets with open blockers', () => {
  const blocker = ticket({ title: 'blocker' });
  const blocked = ticket({ title: 'blocked' });
  assert.strictEqual(store.linkTickets(slug, blocked.ref, 'depends-on', blocker.ref).ok, true);
  const checked = result(blocked.ref);
  assert.strictEqual(checked.reason, 'blocked');
  assert.match(checked.message, new RegExp(blocker.ref));
});

test('nativeDispatchRequired accepts available tickets only for native Agent dispatch', () => {
  const t = ticket();
  const checked = result(t.ref);
  assert.strictEqual(checked.ok, false);
  assert.strictEqual(checked.reason, 'native_agent_required');
  assert.match(checked.message, /native_agent/);
  assert.match(checked.message, /Agent tool/);
});

test('CLI work refuses without launching a separate process', () => {
  const t = ticket();
  const res = runCli(['work', '--ref', t.ref]);
  assert.notStrictEqual(res.status, 0);
  assert.match(res.stderr, /work .*disabled/i);
  assert.match(res.stderr, /native-agent.*Agent tool/i);
});

test('CLI work without --ref also directs callers to native Agent dispatch', () => {
  const res = runCli(['work']);
  assert.notStrictEqual(res.status, 0);
  assert.match(res.stderr, /native-agent.*Agent tool/i);
});

test('native-only source guard keeps process launchers out of routed work', () => {
  const source = fs.readFileSync(path.join(ROOT, 'lib', 'work.js'), 'utf8');
  assert.doesNotMatch(source, /require\(['"]child_process['"]\)/);
  assert.doesNotMatch(source, /\bclaude\b\s*-p/);
  assert.doesNotMatch(source, /\bspawn\s*\(/);
});
