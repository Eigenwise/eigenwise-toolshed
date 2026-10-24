import './_temp-cleanup.js';
import './_sidequest-install-fixture.js';
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-story-evidence-project-'));
process.env.SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-story-evidence-home-'));
process.env.SIDEQUEST_DISCOVERY_DIRS = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-story-evidence-catalog-'));
process.env.CLAUDE_PROJECT_DIR = project;
execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: project });
execFileSync('git', ['-c', 'user.email=test@example.invalid', '-c', 'user.name=Fixture', 'commit', '--quiet', '--allow-empty', '-m', 'seed'], { cwd: project });
const store = require('../lib/store.js');
const agentsync = require('../lib/agentsync.js');
const slug = store.ensureProject(project).slug;

function evidenceChild(storyRef: string, title: string) {
  const ticket = store.createTicket(slug, { title, category: 'research.evidence', storyId: storyRef, source: 'test' });
  const sessionId = 'story-evidence-' + ticket.id;
  const prepared = store.prepareDispatch(slug, ticket.ref, { sharedTree: true, sessionId, runtimeCwd: project });
  const executor = prepared.ticket.dispatchExecutor;
  const by = 'owner-' + ticket.id;
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, { sessionId, token: prepared.token, executor, agentName: by }).ok, true);
  assert.equal(store.bindDispatchAgent(sessionId, executor, by, by).ok, true);
  assert.equal(store.claimTicket(slug, ticket.ref, by, { sessionId, token: prepared.token, executor }).ok, true);
  return { ticket: store.getTicket(slug, ticket.ref), sessionId, by };
}

function briefing(ref: string): string {
  const ticket = store.getTicket(slug, ref);
  return agentsync.renderTicketBriefing({ ...ticket, category: {}, dispatch: { ...ticket.dispatch, tokenFile: path.join(project, 'token') } }, 'story-evidence-token', slug, project);
}

test('dependent briefing names both completed evidence parents and their actual done first lines', () => {
  const story = store.createStory(slug, { title: 'Two sources and synthesis' });
  const first = evidenceChild(story.ref, 'First source');
  const second = evidenceChild(story.ref, 'Second source');
  const synthesis = store.createTicket(slug, { title: 'Synthesis', storyId: story.ref, source: 'test' });
  store.linkTickets(slug, synthesis.ref, 'depends-on', first.ticket.ref);
  store.linkTickets(slug, synthesis.ref, 'depends-on', second.ticket.ref);
  fs.writeFileSync(path.join(first.ticket.dispatch.evidenceDirectory, 'first.json'), '{}');
  fs.writeFileSync(path.join(second.ticket.dispatch.evidenceDirectory, 'second.json'), '{}');
  assert.equal(store.completeTicket(slug, first.ticket.ref, first.by, { sessionId: first.sessionId, body: 'Saved evidence: first.json\nFirst detail stays out of provenance' }).ok, true);
  assert.equal(store.completeTicket(slug, second.ticket.ref, second.by, { sessionId: second.sessionId, body: 'Saved evidence: second.json\nSecond detail stays out of provenance' }).ok, true);
  store.addComment(slug, first.ticket.ref, { by: 'later', body: 'Later comment is not the done report' });
  const text = briefing(synthesis.ref);
  assert.ok(text.includes('Parent evidence:\n- ' + first.ticket.ref + ': ' + first.ticket.dispatch.evidenceDirectory + '\n  Saved evidence: first.json'));
  assert.ok(text.includes('- ' + second.ticket.ref + ': ' + second.ticket.dispatch.evidenceDirectory + '\n  Saved evidence: second.json'));
  assert.doesNotMatch(text, /detail stays out of provenance|Later comment is not/);
  const root = store.ticketEvidenceDirectory(slug, story.ref, project);
  assert.ok(text.includes('Story evidence root: ' + root));
  assert.ok(text.includes(path.join(root, 'manifest.sha256.json')));
  assert.ok(text.includes('append {sha256, path, source, savedBy}'));
});

test('released evidence parent remains pending without advertising its directory or done report', () => {
  const story = store.createStory(slug, { title: 'Pending source' });
  const parent = evidenceChild(story.ref, 'Released source');
  const synthesis = store.createTicket(slug, { title: 'Waiting synthesis', storyId: story.ref, source: 'test' });
  store.linkTickets(slug, synthesis.ref, 'depends-on', parent.ticket.ref);
  assert.equal(store.releaseTicket(slug, parent.ticket.ref, parent.by, { sessionId: parent.sessionId, status: 'todo' }).ok, true);
  const text = briefing(synthesis.ref);
  assert.ok(text.includes('- ' + parent.ticket.ref + ': pending (todo)'));
  assert.ok(!text.includes(parent.ticket.dispatch.evidenceDirectory));
});

test('briefing omits story evidence root for a storyless ticket and an uncreated story root', () => {
  const storyless = store.createTicket(slug, { title: 'No story', source: 'test' });
  assert.doesNotMatch(briefing(storyless.ref), /Story evidence root:|manifest.sha256.json|Parent evidence:/);
  const story = store.createStory(slug, { title: 'No evidence dispatch yet' });
  const child = store.createTicket(slug, { title: 'Before evidence', storyId: story.ref, source: 'test' });
  assert.doesNotMatch(briefing(child.ref), /Story evidence root:|manifest.sha256.json/);
});
