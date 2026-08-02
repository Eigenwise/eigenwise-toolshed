import './_temp-cleanup.js';
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { makeCliRunner } = require('./_helpers.js');

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-body-file-test-'));
const PROJ = path.join(os.tmpdir(), 'sq-body-file-fixtures', 'board');
const BIN = path.join(__dirname, '..', 'bin', 'sidequest.js');
const { cliJson } = makeCliRunner(BIN, { SIDEQUEST_HOME, CLAUDE_PROJECT_DIR: PROJ });

function bodyFile(name?: any, body?: any) {
  const file = path.join(SIDEQUEST_HOME, name);
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

function ticket(title?: any) {
  return cliJson(['add', '--title', title, '--complexity', '2', '--why', 'a small CLI fixture for body-file round-trip coverage', '--label', 'direct-ok', '--json']).ticket.ref;
}

test('comment reads markdown unchanged from --body-file', () => {
  const ref = ticket('comment body-file fixture');
  const body = 'Installed `claude-code-proxy 0.1.17` (with "quotes").\n\n- `node --test` passed';
  cliJson(['comment', ref, '--body-file', bodyFile('comment.md', body), '--json']);

  const stored = cliJson(['comments', ref, '--json']).comments.at(-1);
  assert.strictEqual(stored.body, body);
});

test('comment body-file stores a 5,481-character handoff whole', () => {
  const ref = ticket('long comment body-file fixture');
  const body = `Decision: keep the full evidence on the ticket.\n\n${'x'.repeat(5432)}`;
  assert.strictEqual(body.length, 5481);
  const result = cliJson(['comment', ref, '--body-file', bodyFile('long-comment.md', body), '--json']);
  assert.match(result.advisory, /body stored in full \(5\.4 KB\); default reads excerpt bodies past 1200 chars/);

  const stored = cliJson(['comments', ref, '--json']).comments.at(-1);
  assert.strictEqual(stored.body, body);
});
