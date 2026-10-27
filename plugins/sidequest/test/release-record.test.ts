'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../lib/store.js');
const db = require('../lib/db.js');
const { makeCliRunner } = require('./_helpers.js');

const DELIVERY = 'a'.repeat(40);
const RELEASE = 'b'.repeat(40);
const input = { version: 'v6.7.0', plugins: ['sidequest@6.7.0'], commit: RELEASE };

function deliveredTicket(status = 'done') {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-shipped-'));
  const { slug } = store.ensureProject(projectPath);
  const created = store.createTicket(slug, { title: 'Delivered change', status });
  const ticket = store.getTicket(slug, created.ref);
  ticket.submission = { commit: DELIVERY, integratedAt: '2026-10-27T10:00:00Z', integration: { mode: 'merge', outcome: 'verified', pinnedCommit: DELIVERY, resultingHead: 'c'.repeat(40), targetBranch: 'develop' } };
  saveTicket(slug, ticket);
  return { slug, ticket, projectPath };
}

function saveTicket(slug: string, ticket: { id: string; ref: string; status: string }) {
  db.putRow(db.openDb(process.env.SIDEQUEST_HOME), 'tickets', { id: ticket.id, project: slug, ref: ticket.ref, status: ticket.status, archived: 0, ord: 0, claim_by: null, data: ticket });
}

test('release-record persists a delivery-bound cut and is idempotent per version', () => {
  const { slug, ticket } = deliveredTicket();
  const first = store.recordShippedRelease(slug, ticket.ref, input);
  assert.equal(first.recorded, true);
  assert.deepEqual(first.record, { ...input, deliveryCommit: DELIVERY, at: first.record.at });
  assert.equal(store.completionPayload(slug, ticket.ref).stage, 'released');
  assert.deepEqual(store.completionPayload(slug, ticket.ref).facts.release, { version: 'v6.7.0', evidence: 'release-record' });
  const second = store.recordShippedRelease(slug, ticket.ref, { ...input, commit: 'd'.repeat(40) });
  assert.equal(second.recorded, false);
  assert.deepEqual(second.record, first.record);
  assert.equal(store.getTicket(slug, ticket.ref).shipped.length, 1);
  store.recordShippedRelease(slug, ticket.ref, { ...input, version: 'v6.8.0' });
  assert.equal(store.completionPayload(slug, ticket.ref).facts.release.version, 'v6.8.0');
});

test('a shipped record cannot release a different delivery or a readonly closeout', () => {
  const { slug, ticket } = deliveredTicket();
  store.recordShippedRelease(slug, ticket.ref, input);
  ticket.shipped = store.getTicket(slug, ticket.ref).shipped;
  ticket.submission.integration.pinnedCommit = 'd'.repeat(40);
  saveTicket(slug, ticket);
  assert.equal(store.completionPayload(slug, ticket.ref).stage, 'integrated');
  assert.deepEqual(store.completionPayload(slug, ticket.ref).facts.release, { version: null, evidence: 'none' });
  const readonly = store.createTicket(slug, { title: 'Readonly', status: 'done' });
  assert.equal(store.recordShippedRelease(slug, readonly.ref, input).record.deliveryCommit, null);
  assert.equal(store.completionPayload(slug, readonly.ref).stage, 'closed');
});

test('release-record refuses unfinished or missing tickets and malformed inputs', () => {
  const { slug, ticket } = deliveredTicket('todo');
  assert.throws(() => store.recordShippedRelease(slug, ticket.ref, input), /must be done/);
  assert.throws(() => store.recordShippedRelease(slug, 'SQ-9999', input), /not found/);
  assert.throws(() => store.recordShippedRelease(slug, ticket.ref, { ...input, version: '6.7.0' }), /version/);
  assert.throws(() => store.recordShippedRelease(slug, ticket.ref, { ...input, commit: 'short' }), /commit/);
  assert.throws(() => store.recordShippedRelease(slug, ticket.ref, { ...input, plugins: 'sidequest' }), /array/);
  assert.throws(() => store.recordShippedRelease(slug, ticket.ref, { ...input, plugins: ['sidequest'] }), /plugin@/);
  assert.equal(store.getTicket(slug, ticket.ref).shipped, undefined);
});

test('release-record CLI accepts repeated plugin flags and exposes the released completion', () => {
  const { slug, ticket, projectPath } = deliveredTicket();
  const { cliJson, runCli } = makeCliRunner(path.join(__dirname, '../bin/sidequest.js'));
  const argumentsList = ['release-record', ticket.ref, '--project', projectPath, '--version', input.version, '--commit', RELEASE, '--plugin', 'sidequest@6.7.0', '--plugin', 'quartermaster@1.0.0'];
  const result = cliJson(argumentsList);
  assert.equal(result.recorded, true);
  assert.deepEqual(result.record.plugins, ['quartermaster@1.0.0', 'sidequest@6.7.0']);
  assert.equal(cliJson(['completion', ticket.ref, '--project', projectPath, '--json']).stage, 'released');
  assert.equal(cliJson(argumentsList).recorded, false);
  assert.notEqual(runCli(['release-record', '--project', projectPath]).status, 0);
  const unfinished = store.createTicket(slug, { title: 'Still running' });
  assert.notEqual(runCli(['release-record', unfinished.ref, '--project', projectPath, '--version', input.version, '--commit', RELEASE]).status, 0);
});
