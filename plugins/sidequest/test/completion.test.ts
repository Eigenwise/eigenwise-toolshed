'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../lib/store.js');
const db = require('../lib/db.js');
const mcp = require('../lib/mcp.js');
const { completionView, completionText, COMPLETION_TEXT_MAX_WORDS } = require('../lib/store/completion.js');
const { makeCliRunner, makeMcpCaller } = require('./_helpers.js');

const { callTool } = makeMcpCaller(mcp);
const CANDIDATE = 'a'.repeat(40);
const DELIVERED_HEAD = 'b'.repeat(40);
const SUBMITTER = 'sq-exec-completion';

function board(label: string) {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), `sq-completion-${label}-`));
  return { slug: store.ensureProject(projectPath).slug, projectPath };
}

function persist(slug: string, ticket: any) {
  db.putRow(db.openDb(process.env.SIDEQUEST_HOME), 'tickets', {
    id: ticket.id,
    project: slug,
    ref: ticket.ref,
    status: ticket.status,
    archived: ticket.archived ? 1 : 0,
    ord: ticket.order,
    claim_by: ticket.claim ? ticket.claim.by : null,
    data: ticket,
  });
}

function ticketWith(slug: string, title: string, fields: Record<string, unknown>) {
  const created = store.createTicket(slug, { title, source: 'test' });
  const ticket = Object.assign(store.getTicket(slug, created.id), fields);
  persist(slug, ticket);
  return store.getTicket(slug, created.id);
}

function submission(extra: Record<string, unknown> = {}) {
  return Object.assign({ by: SUBMITTER, at: '2026-10-27T10:00:00.000Z', commit: CANDIDATE, verify: 'npm test', integratedAt: null }, extra);
}

function deliveredSubmission(verify: Record<string, unknown>) {
  return submission({
    integratedAt: '2026-10-27T11:00:00.000Z',
    integration: { mode: 'merge', outcome: 'verified', targetBranch: 'develop', resultingHead: DELIVERED_HEAD, pinnedCommit: CANDIDATE, deliveredAt: '2026-10-27T11:00:00.000Z', verify },
  });
}

function viewOf(slug: string, ref: string) {
  const view = store.completionPayload(slug, ref);
  assert.ok(view, `completion view for ${ref}`);
  return view;
}

function wordCount(value: string) {
  return value.split(/\s+/).filter(Boolean).length;
}

test('a pending submission reads submitted, never integrated', () => {
  const { slug } = board('submitted');
  const ticket = ticketWith(slug, 'Submitted work', { status: 'doing', submission: submission() });
  const view = viewOf(slug, ticket.ref);
  assert.equal(view.stage, 'submitted');
  assert.equal(view.facts.delivery, null);
  assert.equal(view.blocker.actor, 'orchestrator');
  assert.match(view.text, /Result: Submitted a{12} by sq-exec-completion; not integrated yet\./);
  assert.doesNotMatch(view.text, /Delivered/);
});

test('a delivery without a release record reads integrated, not released', () => {
  const { slug } = board('integrated');
  const ticket = ticketWith(slug, 'Delivered work', {
    status: 'done',
    submission: deliveredSubmission({ status: 'passed', command: 'npm test', quality: [{ status: 'measured', enforced: 3, failures: [], unverified: [], branches: [] }] }),
  });
  const view = viewOf(slug, ticket.ref);
  assert.equal(view.stage, 'integrated');
  assert.deepEqual(view.facts.release, { version: null, evidence: 'none' });
  assert.equal(view.facts.delivery.method, 'merge');
  assert.equal(view.facts.delivery.head, DELIVERED_HEAD);
  assert.equal(view.facts.quality.status, 'measured-pass');
  assert.match(view.text, /No release record; shipping is unconfirmed\./);
  assert.match(view.text, /Your action: No action needed\./);

  const released = completionView(store.getTicket(slug, ticket.ref), { releaseRecord: { version: '6.7.0', deliveryCommit: CANDIDATE } });
  assert.equal(released.stage, 'released');
  assert.equal(released.facts.release.evidence, 'release-record');
});

test('a done readonly ticket with no delivery reads closed', () => {
  const { slug } = board('closed');
  const ticket = ticketWith(slug, 'Readonly investigation', { status: 'done', completion: { by: 'sq-readonly', state: 'done', at: '2026-10-27T09:00:00.000Z' } });
  const view = viewOf(slug, ticket.ref);
  assert.equal(view.stage, 'closed');
  assert.equal(view.blocker, null);
  assert.match(view.text, /Result: Closed without a delivery record\./);
  assert.match(view.text, /Your action: No action needed\./);
});

test('a recorded rework with no new candidate reads rejected and names the executor', () => {
  const { slug } = board('rejected');
  const ticket = ticketWith(slug, 'Reworked work', {
    status: 'todo',
    rejectedSubmissions: [{ commit: CANDIDATE, rejectedAt: '2026-10-27T10:30:00.000Z', rejectedBy: SUBMITTER, reason: 'misses the empty-state case', rejectionKind: 'rework' }],
  });
  const view = viewOf(slug, ticket.ref);
  assert.equal(view.stage, 'rejected');
  assert.equal(view.blocker.actor, 'executor');
  assert.match(view.blocker.reason, /misses the empty-state case/);
  assert.match(view.text, /Your action: No action needed\. Next \(executor\)/);
});

test('an open blocked-by link reads blocked with the dependency refs and next action', () => {
  const { slug } = board('blocked');
  const dependency = store.createTicket(slug, { title: 'Dependency', source: 'test' });
  const blocked = store.createTicket(slug, { title: 'Waits on dependency', source: 'test' });
  assert.equal(store.linkTickets(slug, blocked.ref, 'blocked-by', dependency.ref).ok, true);
  const view = viewOf(slug, blocked.ref);
  assert.equal(view.stage, 'blocked');
  assert.equal(view.blocker.actor, 'dependency');
  assert.deepEqual(view.blocker.refs, [dependency.ref]);
  assert.equal(view.blocker.nextAction, `Finish ${dependency.ref} first.`);
});

test('a legacy ticket with only comments renders facts and no invented Result', () => {
  const { slug } = board('legacy');
  const ticket = store.createTicket(slug, { title: 'Legacy ticket', source: 'test' });
  store.addComment(slug, ticket.id, { by: 'someone', body: 'All tests pass and it shipped in 6.0.' });
  const view = viewOf(slug, ticket.ref);
  assert.equal(view.summary, null);
  assert.equal(view.stage, 'ready');
  assert.equal(view.facts.submission, null);
  assert.equal(view.facts.verify, null);
  assert.match(view.text, /Result: No candidate yet\./);
  assert.doesNotMatch(view.text, /shipped|pass/i);
});

test('a negative-control marker without a capture reads agent-reported', () => {
  const { slug } = board('control');
  const ticket = ticketWith(slug, 'Controlled work', { status: 'doing', submission: submission() });
  store.addComment(slug, ticket.id, {
    by: SUBMITTER,
    body: '[sidequest:negative-control] target=src/lib/store/completion.ts:1; assertion=reads submitted; npm test failed=1 failure-kind=assertion',
  });
  const view = viewOf(slug, ticket.ref);
  assert.deepEqual(view.facts.negativeControl, { kind: 'marker', evidence: 'agent-reported' });
  assert.ok(view.facts.verify === null || !view.facts.verify.kinds.includes('captured-command'));
  assert.match(view.text, /Negative control is agent-reported, not captured\./);
});

test('quality none renders as not measured and never as a pass', () => {
  const { slug } = board('quality');
  const ticket = ticketWith(slug, 'Unmeasured work', {
    status: 'done',
    submission: deliveredSubmission({ status: 'passed', command: 'npm test', quality: [{ status: 'none', enforced: 0, failures: [], unverified: [], branches: [] }] }),
  });
  const view = viewOf(slug, ticket.ref);
  assert.equal(view.facts.quality.status, 'none');
  assert.match(view.text, /Quality: not measured \(no quality gate configured\)\./);
  assert.doesNotMatch(view.text, /Quality: measured, passed/);
});

test('the text stays within 200 words and escapes agent text', () => {
  const { slug } = board('escape');
  const longReason = '<script>alert(1)</script> ' + 'word '.repeat(400);
  const ticket = ticketWith(slug, 'Escaping <script>alert(2)</script>', {
    status: 'todo',
    rejectedSubmissions: [{ commit: CANDIDATE, rejectedAt: '2026-10-27T10:30:00.000Z', reason: longReason, rejectionKind: 'rework' }],
    completionSummary: { version: 1, result: '<script>steal()</script> done', checked: 'word '.repeat(300), uncertain: 'word '.repeat(300), action: 'none', by: SUBMITTER, at: '2026-10-27T10:00:00.000Z', candidate: 'c'.repeat(40) },
  });
  store.addComment(slug, ticket.id, { by: 'someone', body: '<script>alert(3)</script>' });
  const view = viewOf(slug, ticket.ref);
  assert.ok(wordCount(view.text) <= COMPLETION_TEXT_MAX_WORDS, `text has ${wordCount(view.text)} words`);
  assert.doesNotMatch(view.text, /<script>/);
  assert.match(view.text, /&lt;script&gt;/);
  assert.equal(view.stage, 'rejected', 'a summary never changes the derived stage');
  assert.equal(view.summary.stale, true);
  assert.equal(completionText(view), view.text);
  for (const label of ['Result: ', 'Checked: ', 'Still uncertain: ', 'Your action: ']) assert.ok(view.text.includes(label), `has ${label}`);
});

test('evidence paths outside the approved roots are dropped', () => {
  const { slug, projectPath } = board('roots');
  const outside = path.join(os.tmpdir(), 'not-approved', 'secret.log');
  const inside = path.join(store.projectDir(slug), 'verification', 'capture.log');
  const ticket = ticketWith(slug, 'Evidence roots', {
    status: 'doing',
    submission: submission({ changedPaths: ['src/a.ts', 'test/a.test.ts'] }),
    verificationCaptures: [
      { id: 'one', command: 'npm test', status: 'passed', candidate: { source: 'git', value: CANDIDATE }, logPath: outside, completedAt: '2026-10-27T10:00:00.000Z' },
      { id: 'two', command: 'npm test', status: 'passed', candidate: { source: 'git', value: CANDIDATE }, logPath: inside, completedAt: '2026-10-27T10:01:00.000Z' },
    ],
  });
  const view = viewOf(slug, ticket.ref);
  const paths = view.evidence.map((entry: any) => entry.path);
  assert.ok(!paths.includes(outside), 'outside path dropped');
  assert.ok(paths.includes(inside), 'verification-dir path kept');
  assert.ok(paths.includes(path.join(projectPath, 'test/a.test.ts')), 'project test path kept');
  assert.equal(view.evidence.find((entry: any) => entry.path === inside).kind, 'captured-command');
  assert.ok(view.facts.verify.kinds.includes('captured-command'));
  assert.ok(view.facts.verify.kinds.includes('mocked-test'));
  assert.ok(!view.facts.verify.kinds.includes('real-flow'), 'a changed test is never real-flow');
});

test('the MCP completion read returns ticket and story views and text', async () => {
  const { slug } = board('mcp');
  const ticket = ticketWith(slug, 'MCP read', { status: 'doing', submission: submission() });
  const view = await callTool('completion', { project: slug, ref: ticket.ref });
  assert.equal(view.stage, 'submitted');
  assert.equal(view.ref, ticket.ref);
  const rendered = await callTool('completion', { project: slug, ref: ticket.ref, text: true });
  assert.deepEqual(Object.keys(rendered).sort(), ['project', 'ref', 'stage', 'text']);
  assert.equal(rendered.text, view.text);
  const createdStory = store.createStory(slug, { title: 'Empty story' });
  const story = await callTool('completion', { project: slug, story: createdStory.ref });
  assert.equal(story.stage, 'proposed');
  assert.equal(story.ref, createdStory.ref);
});

test('the CLI completion command prints the text by default and the view with --json', () => {
  const { slug, projectPath } = board('cli');
  const ticket = ticketWith(slug, 'CLI read', { status: 'doing', submission: submission() });
  const { runCli, cliJson } = makeCliRunner(path.join(__dirname, '..', 'bin', 'sidequest.js'), { SIDEQUEST_HOME: process.env.SIDEQUEST_HOME });
  const text = runCli(['completion', ticket.ref, '--project', projectPath, '--text']);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^SQ-\d+ CLI read \[submitted\]\nResult: /);
  const view = cliJson(['completion', ticket.ref, '--json', '--project', projectPath]);
  assert.equal(view.stage, 'submitted');
  const swallowed = runCli(['completion', ticket.ref, '--text', '--project', projectPath]);
  assert.equal(swallowed.status, 1);
  assert.match(swallowed.stderr, /--text takes no value/);
});
