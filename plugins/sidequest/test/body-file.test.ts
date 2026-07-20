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
  return cliJson(['add', '--title', title, '--complexity', '2', '--why', 'a small CLI fixture for body-file round-trip coverage', '--json']).ticket.ref;
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
  cliJson(['comment', ref, '--body-file', bodyFile('long-comment.md', body), '--json']);

  const stored = cliJson(['comments', ref, '--json']).comments.at(-1);
  assert.strictEqual(stored.body, body);
});

test('done reads --body-file into its closing comment before completing', () => {
  const ref = ticket('done body-file fixture');
  cliJson(['claim', ref, '--by', 'body-file-worker', '--direct', '--json']);
  const body = 'Shipped `abc1234` (all checks passed).';
  const done = cliJson(['done', ref, '--by', 'body-file-worker', '--body-file', bodyFile('done.md', body), '--json']);
  assert.strictEqual(done.ticket.status, 'done');

  const stored = cliJson(['comments', ref, '--json']).comments.at(-1);
  assert.strictEqual(stored.body, body);
  assert.strictEqual(stored.by, 'body-file-worker');
});

test('done retry after a lost response returns the existing completion without duplicating its comment', () => {
  const ref = ticket('done idempotency retry fixture');
  const by = 'done-retry-worker';
  const body = 'Verified `node --test` after the completion retry.';
  cliJson(['claim', ref, '--by', by, '--direct', '--json']);

  const first = cliJson(['done', ref, '--by', by, '--body-file', bodyFile('done-retry.md', body), '--json']);
  const retry = cliJson(['done', ref, '--by', by, '--body-file', bodyFile('done-retry.md', body), '--json']);
  assert.strictEqual(first.idempotent, undefined);
  assert.strictEqual(retry.ok, true);
  assert.strictEqual(retry.idempotent, true);

  const comments = cliJson(['comments', ref, '--json']).comments;
  assert.strictEqual(comments.filter((comment?: any) => comment.body === body && comment.by === by).length, 1);

  cliJson(['comment', ref, '--by', by, '--body-file', bodyFile('later-comment.md', body), '--json']);
  const laterComments = cliJson(['comments', ref, '--json']).comments;
  assert.strictEqual(laterComments.filter((comment?: any) => comment.body === body && comment.by === by).length, 2);
});
