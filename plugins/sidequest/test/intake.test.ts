import './_temp-cleanup.js';
import './_gateway-catalog-freshness.js';
import './_sidequest-install-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createIntake, newStoryIntake, type IntakeStory, type IntakeTicket } from '../src/lib/store/intake.js';

function policyFixture() {
  const story: IntakeStory = { id: 'story', ref: 'US-1', contractRevision: 1, updatedAt: '', intake: newStoryIntake('requester', 'now') };
  const configuration = { intake: { mode: 'stories' } };
  const policy = createIntake({
    boardConfig: () => configuration,
    getStory: () => story,
    getCategory: reference => ({ readonly: reference === 'research' }),
    putStory: (_slug, replacement) => { Object.assign(story, replacement); },
    transaction: operation => operation(),
    updateTicket: () => null,
  });
  return { story, configuration, ...policy };
}

test('intake policy passes every exemption and refuses stale or absent approval with remedies', () => {
  const fixture = policyFixture();
  const ticket: IntakeTicket = { storyId: 'story', category: 'coding' };
  assert.deepEqual(fixture.intakeDispatchRefusal('board', ticket), { reason: 'intake_not_approved', message: 'US-1 intake is drafting. Run the intake round and approve through story_intake approve, or set intakeExempt with a reason naming size, reversibility and stakes.' });
  for (const exempt of [{}, { storyId: 'story', category: 'research' }, { storyId: 'story', category: { readonly: true } }, { storyId: 'story', categoryId: 'research' }, { storyId: 'story', intakeExempt: { reason: 'tiny reversible private fix' } }]) {
    assert.equal(fixture.intakeDispatchRefusal('board', exempt), null);
  }
  fixture.configuration.intake.mode = 'off';
  assert.equal(fixture.intakeDispatchRefusal('board', ticket), null);
  fixture.configuration.intake.mode = 'stories';
  fixture.storyIntake('board', { story: 'US-1', action: 'approve', by: 'requester' });
  assert.equal(fixture.intakeDispatchRefusal('board', ticket), null);
  fixture.story.contractRevision++;
  assert.equal(fixture.intakeDispatchRefusal('board', ticket)?.reason, 'intake_not_approved');
});

test('intake write validation preserves rejected records and requester authority', () => {
  const fixture = policyFixture();
  assert.throws(() => fixture.storyIntake('board', { action: 'delegate', story: 'US-1', by: 'stranger', namedBy: 'stranger' }), /only the requester/);
  assert.throws(() => fixture.storyIntake('board', { action: 'approve', story: 'US-1', by: 'stranger' }), /requester or/);
  assert.throws(() => fixture.storyIntake('board', { action: 'playback', story: 'US-1', by: 'requester' }), /text is required/);
  assert.equal(fixture.story.intake?.status, 'drafting');
  fixture.storyIntake('board', { action: 'reopen', story: 'US-1', by: 'requester', reason: 'new direction' });
  assert.equal(fixture.story.intake?.status, 'reopened');
  fixture.storyIntake('board', { action: 'question', story: 'US-1', by: 'requester', text: 'Which direction?', options: [{ label: 'A', reason: 'faster' }] });
  assert.equal(fixture.story.intake?.status, 'awaiting-human');
});

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-intake-home-'));
process.env.SIDEQUEST_HOME = home;
const store = require('../lib/store.js');
const mcp = require('../lib/mcp.js');
const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-intake-project-'));
const project = store.ensureProject(projectPath).slug;

async function call(name: string, argumentsObject: Record<string, unknown>) {
  const response = await mcp.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { project, ...argumentsObject } } });
  return response.result;
}

async function intakeAction(argumentsObject: Record<string, unknown>) {
  const response = await call('story_intake', { by: 'requester', ...argumentsObject });
  assert.ok(!response.isError, response.content[0].text);
  return JSON.parse(response.content[0].text).result;
}

test('MCP intake actions persist playback sizing cycles answers delegates approval reopen and exemption', async () => {
  const added = await call('story', { action: 'add', title: 'Intake', by: 'requester' });
  const story = JSON.parse(added.content[0].text).story;
  assert.equal(story.intake.requester.by, 'requester');
  const reference = { story: story.ref };
  const playback = await intakeAction({ ...reference, action: 'playback', text: 'Requester wants A; inference: B' });
  assert.equal(playback.intake.playback.text, 'Requester wants A; inference: B');
  assert.ok(playback.intake.playback.at);
  const sized = await intakeAction({ ...reference, action: 'sizing', size: 'one-wave', reason: 'two independent pieces' });
  assert.equal(sized.intake.sizing.size, 'one-wave');
  const reviewed = await intakeAction({ ...reference, action: 'cycle', review: 'SQ-1', findings: 'one gap resolved', research: ['SQ-2'] });
  assert.equal(reviewed.intake.status, 'reviewing');
  assert.deepEqual(reviewed.intake.cycles[0].researchRefs, ['SQ-2']);
  const questioned = await intakeAction({ ...reference, action: 'question', text: 'Choose?', options: [{ label: 'A', recommended: true, reason: 'least cost' }] });
  assert.equal(questioned.intake.status, 'awaiting-human');
  const answered = await intakeAction({ ...reference, action: 'answer', id: 'q1', answer: 'A', assumption: true });
  assert.equal(answered.intake.questions[0].assumption, true);
  const actual = await intakeAction({ ...reference, action: 'answer', id: 'q1', answer: 'A' });
  assert.equal(actual.intake.questions[0].assumption, undefined);
  assert.equal(actual.intake.questions[0].answeredBy, 'requester');
  const refused = await call('story_intake', { ...reference, action: 'approve', by: 'stranger' });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /requester or a requester-named delegate/);
  await intakeAction({ ...reference, action: 'delegate', by: 'delegate', namedBy: 'requester' });
  const approved = await intakeAction({ ...reference, action: 'approve', by: 'delegate' });
  assert.equal(approved.intake.status, 'approved');
  assert.equal(approved.intake.approval.contractRevision, approved.contractRevision);
  const reopened = await intakeAction({ ...reference, action: 'reopen', reason: 'material direction change' });
  assert.equal(reopened.intake.approval, null);
  assert.equal(reopened.intake.status, 'reopened');
  const ticket = store.createTicket(project, { title: 'tiny fix', source: 'test' });
  const invalid = await call('story_intake', { action: 'exempt', ref: ticket.ref, by: 'requester', reason: 'short' });
  assert.equal(invalid.isError, true);
  const exempt = await intakeAction({ action: 'exempt', ref: ticket.ref, reason: 'tiny reversible private fix, focused check' });
  assert.equal(exempt.intakeExempt.reason, 'tiny reversible private fix, focused check');
  const updated = await call('update', { ref: ticket.ref, intakeExempt: { reason: 'tiny reversible fix with no public changes' }, by: 'orchestrator' });
  assert.ok(!updated.isError, updated.content[0].text);
  assert.equal(store.getTicket(project, ticket.ref).intakeExempt.reason, 'tiny reversible fix with no public changes');
  const serialized = await call('story', { action: 'show', story: story.ref });
  assert.equal(JSON.parse(serialized.content[0].text).story.intake.status, 'reopened');
});

test('MCP add preserves validated intake exemptions and rejects short reasons', async () => {
  const reason = 'tiny reversible private fix with a focused check';
  const added = await call('add', { title: 'exempt at creation', unclassified: true, intakeExempt: { reason } });
  assert.ok(!added.isError, added.content[0].text);
  const ticket = JSON.parse(added.content[0].text);
  assert.deepEqual(store.getTicket(project, ticket.ref).intakeExempt, { reason });
  const invalid = await call('add', { title: 'invalid exemption', unclassified: true, intakeExempt: { reason: 'short' } });
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /20/);
  assert.throws(() => store.createTicket(project, { title: 'invalid direct exemption', intakeExempt: { reason: 'short' } }), /20/);
  assert.equal(store.createTicket(project, { title: 'no exemption' }).intakeExempt, null);
});

test('board intake normalization defaults validates and serializes through MCP', async () => {
  assert.deepEqual(store.boardConfig(project).intake, { mode: 'off', reviewCycles: 1 });
  const response = await call('board_config', { intake: { mode: 'stories', reviewCycles: 3 } });
  assert.ok(!response.isError, response.content[0].text);
  assert.deepEqual(JSON.parse(response.content[0].text).intake, { mode: 'stories', reviewCycles: 3 });
  for (const intake of [{ mode: 'bad' }, { reviewCycles: 0 }, { reviewCycles: 4 }, { reviewCycles: '2' }, null, []]) {
    assert.throws(() => store.setBoardConfig(project, { intake }), /intake/);
  }
  assert.deepEqual(store.setBoardConfig(project, { intake: {} }).config.intake, { mode: 'off', reviewCycles: 1 });
});

test('CLI intake playback and board policy share store behavior', () => {
  const story = store.createStory(project, { title: 'CLI', by: 'requester' });
  const cli = path.resolve(__dirname, '../bin/sidequest.js');
  const result = spawnSync(process.execPath, [cli, 'story', 'intake', story.ref, 'playback', '--text', 'CLI direction', '--by', 'requester', '--project', projectPath, '--json'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).result.intake.playback.text, 'CLI direction');
  const configured = spawnSync(process.execPath, [cli, 'board-config', '--intake-mode', 'stories', '--intake-review-cycles', '2', '--project', projectPath, '--json'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(configured.status, 0, configured.stderr);
  assert.deepEqual(JSON.parse(configured.stdout).intake, { mode: 'stories', reviewCycles: 2 });
});
