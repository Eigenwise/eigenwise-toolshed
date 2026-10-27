import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CompletionTicket, CompletionView, completionView, storyCompletionView } from '../src/lib/store/completion.js';
const store = require('../lib/store.js');
const database = require('../lib/db.js');
const { makeMcpCaller, makeCliRunner } = require('./_helpers.js');
const { callTool } = makeMcpCaller(require('../lib/mcp.js'));
const candidate = 'a'.repeat(40);

function fixture(title = 'Story outcome') {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-story-completion-'));
  const slug = store.ensureProject(projectPath).slug;
  const story = store.createStory(slug, { title });
  return { slug, story, projectPath };
}

function child(slug: string, storyId: string, fields: Record<string, unknown> = {}) {
  const ticket = store.createTicket(slug, { title: 'Story child', storyId, source: 'test' });
  const updated = Object.assign(store.getTicket(slug, ticket.ref), fields);
  database.putRow(database.openDb(process.env.SIDEQUEST_HOME), 'tickets', {
    id: updated.id, project: slug, ref: updated.ref, status: updated.status,
    archived: updated.archived ? 1 : 0, ord: updated.order, claim_by: updated.claim?.by ?? null, data: updated,
  });
  return updated;
}

function delivery() {
  return {
    status: 'done',
    submission: {
      commit: candidate, integratedAt: '2026-10-27T10:00:00Z',
      integration: { outcome: 'verified', mode: 'merge', deliveryCommit: candidate, targetBranch: 'develop', verify: { status: 'passed', command: 'npm test' } },
    },
  };
}

function read(slug: string, ref: string) {
  return store.storyCompletionPayload(slug, ref);
}

test('all integrated children produce integrated, never released, with honest evidence counts', () => {
  const { slug, story } = fixture();
  const first = child(slug, story.id, delivery());
  child(slug, story.id, delivery());
  child(slug, story.id, { archived: true });
  const view = read(slug, story.ref);
  assert.equal(view.stage, 'integrated');
  assert.equal(view.children.length, 2);
  assert.ok(view.integrated.includes(first.ref));
  assert.deepEqual(view.notYet, []);
  assert.match(view.text, /0 of 2 verified by captured command/);
  assert.match(view.text, /2 quality not measured/);
  assert.match(view.text, /No release record/);
});

test('one blocked child makes partial delivery explicit and surfaces its dependency blocker', () => {
  const { slug, story } = fixture();
  const delivered = child(slug, story.id, delivery());
  const dependency = store.createTicket(slug, { title: 'Dependency', source: 'test' });
  const blocked = child(slug, story.id);
  store.linkTickets(slug, blocked.ref, 'blocked-by', dependency.ref);
  const view = read(slug, story.ref);
  assert.equal(view.stage, 'partial');
  assert.deepEqual(view.integrated, [delivered.ref]);
  assert.deepEqual(view.notYet, [{ ref: blocked.ref, stage: 'blocked' }]);
  assert.deepEqual(view.blocker.refs, [dependency.ref]);
  assert.match(view.text, new RegExp('Not yet: ' + blocked.ref + ' \\(blocked\\)'));
});

test('a live child claim takes precedence over partial delivery and blocked work', () => {
  const { slug, story } = fixture();
  child(slug, story.id, delivery());
  child(slug, story.id, { status: 'doing', claim: { by: 'story-worker' } });
  assert.equal(read(slug, story.ref).stage, 'running');
});

test('a rejected child reads partial and keeps the rejection visible', () => {
  const { slug, story } = fixture();
  const rejected = child(slug, story.id, { rejectedSubmissions: [{ commit: candidate, reason: 'Misses user input', rejectedAt: '2026-10-27' }] });
  const view = read(slug, story.ref);
  assert.equal(view.stage, 'partial');
  assert.match(view.blocker.reason, /Misses user input/);
  assert.deepEqual(view.notYet, [{ ref: rejected.ref, stage: 'rejected' }]);
});

test('empty and unstarted stories read proposed, unknown stories return null', () => {
  const { slug, story } = fixture();
  assert.equal(read(slug, story.ref).stage, 'proposed');
  assert.doesNotMatch(read(slug, story.ref).text, /No action needed/);
  child(slug, story.id);
  assert.equal(read(slug, story.id).stage, 'proposed');
  assert.equal(read(slug, 'US-999'), null);
});

test('blocked-only story reads blocked and user action wins over other blockers', () => {
  const { slug, story } = fixture();
  const dependency = store.createTicket(slug, { title: 'Dependency', source: 'test' });
  const blocked = child(slug, story.id);
  store.linkTickets(slug, blocked.ref, 'blocked-by', dependency.ref);
  assert.equal(read(slug, story.ref).stage, 'blocked');
  child(slug, story.id, { status: 'awaiting-oracle', oracle: { ask: 'Choose the deployment target.' } });
  const view = read(slug, story.ref);
  assert.equal(view.blocker.actor, 'user');
  assert.match(view.text, /Your action: Answer: Choose the deployment target/);
  assert.doesNotMatch(view.text, /No action needed/);
});

test('story text stays under 250 words, deduplicates uncertainties and keeps agent text as plain text', () => {
  const { slug, story } = fixture('Outcome '.repeat(100));
  for (let index = 0; index < 12; index += 1) {
    child(slug, story.id, { ...delivery(), completionSummary: { version: 1, result: '<script>unsafe</script> '.repeat(100), uncertain: 'Needs real user input.', candidate } });
  }
  const view = read(slug, story.ref);
  assert.ok(view.text.split(/\s+/).length < 250);
  assert.equal(view.uncertainties.filter((value: string) => value.includes('Needs real user input')).length, 1);
  assert.equal(new Set(view.uncertainties).size, view.uncertainties.length);
  assert.ok(view.uncertainties.length <= 6);
  assert.match(view.text, /<script>unsafe<\/script>/);
  assert.doesNotMatch(view.text, /&lt;/);
});

test('story decisions include ticket-naming decisions from live and archived logs', () => {
  const story = { id: 'story', ref: 'US-1', title: 'Decisions', archivedDecisionLog: [{ seq: 1, kind: 'DECISION', ref: 'SQ-1', text: 'Keep the boundary. More detail.' }], decisionLog: [
    { seq: 2, kind: 'DISCOVERY', ref: 'SQ-1', text: 'Discovery.' },
    { seq: 3, kind: 'DECISION', text: 'SQ-2 stays unverified. More detail.' },
    { seq: 4, kind: 'DECISION', text: 'Unrelated decision.' },
  ] };
  const view = storyCompletionView(story, []);
  assert.deepEqual(view.decisions, { count: 2, latest: 'SQ-2 stays unverified.' });
  assert.match(view.text, /Decisions: 2; SQ-2 stays unverified\./);
});

test('released requires every child release record; submitted work stays in notYet', () => {
  const ticket: CompletionTicket = { ref: 'SQ-1', title: 'Delivered', ...delivery() };
  const released = completionView(ticket, { releaseRecord: { version: '7.0', deliveryCommit: candidate } });
  const story = { id: 'story', ref: 'US-1', title: 'Release' };
  assert.equal(storyCompletionView(story, [released]).stage, 'released');
  const pending = completionView({ ref: 'SQ-2', submission: { commit: candidate } }, {});
  const view = storyCompletionView(story, [pending]);
  assert.equal(view.stage, 'running');
  assert.deepEqual(view.notYet, [{ ref: 'SQ-2', stage: 'submitted' }]);
});

test('MCP and CLI return story completion through the real store', async () => {
  const { slug, story, projectPath } = fixture();
  child(slug, story.id, delivery());
  const view = await callTool('completion', { project: slug, story: story.ref });
  assert.equal(view.stage, 'integrated');
  const rendered = await callTool('completion', { project: slug, story: story.ref, text: true });
  assert.equal(rendered.text, view.text);
  const { runCli, cliJson } = makeCliRunner(path.join(__dirname, '..', 'bin', 'sidequest.js'), { SIDEQUEST_HOME: process.env.SIDEQUEST_HOME });
  const result = runCli(['completion', story.ref, '--project', projectPath]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Result: Story outcome/);
  assert.equal(cliJson(['completion', story.ref, '--project', projectPath, '--json']).stage, 'integrated');
});
