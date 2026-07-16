'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-planning-warnings-test-'));
const PROJ = path.join(os.tmpdir(), 'sq-planning-warnings-fixtures', 'board');
const BIN = path.join(__dirname, '..', 'bin', 'sidequest.js');
const WARNING = 'Planning-depth warning: complexity 4+ tickets should include executor anchors, an exact verify command, and declared file scope before dispatch; missing: executor anchors, verify command, file scope.';
const MISSING_SCOPE_WARNING = 'Planning-depth warning: declared file scope does not exist in the repo: missing/scope.js.';

function cliJson(args) {
  const env = Object.assign({}, process.env, { SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: PROJ });
  const res = spawnSync(process.execPath, [BIN, ...args, '--json'], { encoding: 'utf8', env });
  assert.strictEqual(res.status, 0, `expected success: ${args.join(' ')}\n${res.stderr}${res.stdout}`);
  return JSON.parse(res.stdout);
}

test('complexity 4+ add warns for empty executor context and file scope', () => {
  const added = cliJson([
    'add', '-t', 'underscouted add', '--complexity', '4',
    '--why', 'exercise the planning-depth warning on a complexity four ticket',
  ]);

  assert.deepStrictEqual(added.warnings, [WARNING]);
});

test('update warns when a ticket becomes complexity 4+ without planning context', () => {
  const added = cliJson([
    'add', '-t', 'rescore me', '--complexity', '3',
    '--why', 'seed a lower complexity ticket before raising its complexity score',
  ]);
  const updated = cliJson([
    'update', added.ticket.ref, '--complexity', '4',
    '--why', 'raise this ticket to four without adding any executor planning context',
  ]);

  assert.deepStrictEqual(updated.warnings, [WARNING]);
});

test('claim echoes missing planning context for dispatch visibility', () => {
  const added = cliJson([
    'add', '-t', 'claim warning', '--complexity', '4',
    '--why', 'claim a complexity four ticket to expose the dispatch context warning',
  ]);
  const claim = cliJson(['claim', added.ticket.ref, '--by', 'planning-warning-worker']);

  assert.deepStrictEqual(claim.warnings, [
    'Dispatch context warning: complexity 4+ tickets should include executor anchors, an exact verify command, and declared file scope before dispatch; missing: executor anchors, verify command, file scope.',
  ]);
});

test('add warns when declared file scope does not exist in the repo', () => {
  const added = cliJson([
    'add', '-t', 'missing scope', '--complexity', '3',
    '--why', 'exercise warning coverage for an invalid declared scope',
    '--file', 'missing/scope.js',
  ]);

  assert.deepStrictEqual(added.warnings, [MISSING_SCOPE_WARNING]);
});

test('claim echoes declared file scope warning for dispatch visibility', () => {
  const added = cliJson([
    'add', '-t', 'claim missing scope', '--complexity', '3',
    '--why', 'claim a ticket with an invalid declared scope for dispatch warning',
    '--file', 'missing/scope.js',
  ]);
  const claim = cliJson(['claim', added.ticket.ref, '--by', 'scope-warning-worker']);

  assert.deepStrictEqual(claim.warnings, [
    `Dispatch context warning: ${MISSING_SCOPE_WARNING.replace('Planning-depth warning: ', '')}`,
  ]);
});

test('add and update warn only for unknown mentioned ticket refs', () => {
  const known = cliJson(['add', '-t', 'known ref', '--unclassified']);
  const added = cliJson(['add', '-t', `follow ${known.ticket.ref}`, '--description', 'also check SQ-9999', '--unclassified']);
  assert.deepStrictEqual(added.warnings, ['Unknown ticket refs: SQ-9999.']);

  const updated = cliJson(['update', added.ticket.ref, '--title', `follow ${known.ticket.ref} and SQ-9998`]);
  assert.deepStrictEqual(updated.warnings, ['Unknown ticket refs: SQ-9998, SQ-9999.']);
});
