import './_temp-cleanup.js';
import './_sidequest-install-fixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const store = require('../lib/store.js');
const mcp = require('../lib/mcp.js');
const { makeMcpCaller } = require('./_helpers.js');
const { createSummaryCloseout, completionSummaryInput, completionView } = require('../lib/store/completion.js');
const { callTool, callToolRaw } = makeMcpCaller(mcp);
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-summary-project-'));
const { slug } = store.ensureProject(project);
const candidate = 'a'.repeat(40);
const replacement = 'b'.repeat(40);
const by = 'summary-worker';
const summary = { result: 'Shows the saved result, for example SQ-1.', checked: 'Mocked lifecycle fixture saved and read back.', uncertain: 'No real delivery flow exercised.', action: 'none' };

function claimedTicket(title: string) {
  const ticket = store.createTicket(slug, { title, complexity: 2, complexityWhy: 'bounded summary fixture', files: ['fixture.txt'], labels: ['direct-ok'], executorVerifyKind: 'attestation', executorAttestationArtifact: 'summary fixture', source: 'test' });
  assert.equal(store.claimTicket(slug, ticket.ref, by, { direct: true, reason: 'Exercise completion summary persistence', source: 'cli' }).ok, true);
  return ticket;
}

test('submit stores a candidate-bound summary and identical repeat writes nothing', () => {
  const ticket = claimedTicket('submitted summary');
  const options = { commit: candidate, verify: 'manual: inspected saved summary', summary, submissionComment: { by, body: 'Verified summary fixture.', source: 'test' } };
  const result = store.submitTicket(slug, ticket.ref, by, options);
  assert.equal(result.ok, true, JSON.stringify(result));
  const saved = store.getTicket(slug, ticket.ref);
  assert.ok(saved.completionSummary, 'submit persists the structured summary');
  assert.deepEqual(saved.completionSummary, { version: 1, ...summary, by, at: saved.completionSummary.at, candidate });
  assert.equal(saved.claim, null);
  assert.equal(store.submitTicket(slug, ticket.ref, by, options).ok, true);
  assert.deepEqual(store.getTicket(slug, ticket.ref), saved);
  const next = store.submitTicket(slug, ticket.ref, by, { ...options, commit: replacement, verify: 'manual: inspected replacement', summary: undefined, force: true });
  assert.equal(next.ok, true, JSON.stringify(next));
  const view = store.completionPayload(slug, ticket.ref);
  assert.equal(view.summary.stale, true);
  assert.equal(view.summary.candidate, candidate);
  assert.equal(view.stage, 'submitted');
});

test('MCP done stores a summary and identical repeat adds no comment', async () => {
  const ticket = claimedTicket('done summary');
  const options = { project, ref: ticket.ref, by, body: 'Checked the mocked lifecycle fixture.', summary };
  const result = await callTool('done', options);
  assert.equal(result.ok, true);
  const saved = store.getTicket(slug, ticket.ref);
  assert.ok(saved.completionSummary, 'done persists the structured summary');
  assert.equal(saved.completionSummary.candidate, null);
  assert.equal(saved.completionSummary.by, by);
  assert.equal(saved.completionSummary.result, summary.result);
  assert.equal((await callTool('done', options)).ok, true);
  assert.deepEqual(store.getTicket(slug, ticket.ref), saved);
});

test('MCP submit accepts structured summary on the real store path', async () => {
  const ticket = claimedTicket('MCP submit summary');
  fs.writeFileSync(path.join(project, 'fixture.txt'), 'summary revision');
  const sourceRevision = require('../lib/source-revision-capability.js').filesystemSnapshotRevision(project);
  const result = await callToolRaw('submit', { project, ref: ticket.ref, by, sourceRevision, changedSurfaces: ['fixture.txt'], projectCapabilities: { process: false, worktree: false, review: true }, verify: `attestation: ${sourceRevision.value} | reviewed snapshot | fixture saved`, body: 'Fixture report.', summary });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  const response = JSON.parse(result.content[0].text);
  assert.equal(response.ok, true, JSON.stringify(response));
  const saved = store.getTicket(slug, ticket.ref);
  assert.ok(saved.completionSummary, 'MCP submit persists the structured summary');
  assert.equal(saved.completionSummary.result, summary.result);
});

test('facts keep the user blocker before a contradictory agent action and keep text plain', () => {
  const view = completionView({ ref: 'SQ-1', title: 'blocked', status: 'awaiting-oracle', oracle: { ask: 'Authorize the account access.' }, completionSummary: { version: 1, ...summary, action: 'No action needed. <script>', candidate: null } }, {});
  assert.equal(view.blocker.actor, 'user');
  assert.equal(view.stage, 'blocked');
  assert.match(view.text, /Your action: Answer: Authorize the account access\. Agent said: No action needed\. <script>/);
});

test('summary storage failure preserves successful done and records the error', () => {
  const ticket = claimedTicket('summary storage failure');
  const closeout = createSummaryCloseout({
    getTicket: store.getTicket,
    putTicket: () => { throw new Error('summary write unavailable'); },
    addComment: store.addComment,
    withTicketLock: (_slug: string, _ref: string, callback: () => void) => callback(),
  });
  const result = closeout(slug, ticket.ref, by, { summary }, 'done', () => store.completeTicket(slug, ticket.ref, by, { body: 'Done before the summary storage error.' }));
  assert.equal(result.ok, true);
  assert.equal(result.summaryError, 'summary write unavailable');
  const saved = store.getTicket(slug, ticket.ref);
  assert.equal(saved.status, 'done');
  assert.equal(saved.claim, null);
  assert.ok(saved.comments.some((comment: { body: string }) => comment.body.includes('summary write unavailable')));
});

test('legacy closeout without summary retains its ordinary completion', () => {
  const ticket = claimedTicket('legacy completion');
  assert.equal(store.completeTicket(slug, ticket.ref, by, { body: 'Legacy report.' }).ok, true);
  assert.equal(store.completionPayload(slug, ticket.ref).summary, null);
});

test('summary validation rejects malformed fields before changing lifecycle state', async () => {
  const ticket = claimedTicket('invalid summary');
  for (const invalid of [null, {}, { ...summary, action: 'x'.repeat(601) }, { ...summary, result: 2 }, { ...summary, checked: '\u0000' }, { ...summary, stage: 'released' }]) {
    assert.throws(() => completionSummaryInput(invalid), /summary/);
  }
  const result = await callToolRaw('done', { project, ref: ticket.ref, by, body: 'Required report.', summary: { ...summary, action: 'x'.repeat(601) } });
  assert.equal(result.isError, true);
  assert.equal(store.getTicket(slug, ticket.ref).claim.by, by);
});
