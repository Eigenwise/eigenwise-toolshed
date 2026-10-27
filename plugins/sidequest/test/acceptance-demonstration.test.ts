'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../lib/store.js');
const db = require('../lib/db.js');
const mcp = require('../lib/mcp.js');
const agentsync = require('../lib/agentsync.js');
const { completionView, readDemonstrations, acceptanceExamplesInput, ACCEPTANCE_MAX_EXAMPLES, ACCEPTANCE_TEXT_MAX } = require('../lib/store/completion.js');
const { makeMcpCaller } = require('./_helpers.js');

const { callTool } = makeMcpCaller(mcp);
const CANDIDATE = 'c'.repeat(40);
const NEWER_CANDIDATE = 'd'.repeat(40);
const MAIN_EXAMPLE = { scenario: 'list --brief on a board with one ticket', expected: 'one brief row without a description', kind: 'main' };
const BOUNDARY_EXAMPLE = { scenario: 'list --brief on an empty board', expected: 'an empty tickets array', kind: 'boundary' };

function board(label: string) {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), `sq-acceptance-${label}-`));
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

function evidenceDirectory(label: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `sq-acceptance-evidence-${label}-`));
  const directory = path.join(root, 'SQ-1');
  fs.mkdirSync(directory, { recursive: true });
  return { root, directory };
}

function demonstration(overrides: Record<string, unknown> = {}) {
  return Object.assign({
    scenario: MAIN_EXAMPLE.scenario,
    expected: MAIN_EXAMPLE.expected,
    observed: 'one brief row, description absent',
    matches: true,
    environment: 'local test board',
    candidate: CANDIDATE.slice(0, 12),
    fixture: 'seeded by test/brief fixture',
    artifact: 'main.log',
    kind: 'real-flow',
  }, overrides);
}

function recordDemonstrations(directory: string, entries: unknown, artifacts: string[] = ['main.log']) {
  for (const artifact of artifacts) fs.writeFileSync(path.join(directory, artifact), 'observed output\n');
  fs.writeFileSync(path.join(directory, 'demonstrations.json'), JSON.stringify(entries));
}

function submittedTicket(extra: Record<string, unknown> = {}) {
  return Object.assign({
    ref: 'SQ-1',
    title: 'Acceptance fixture',
    status: 'todo',
    acceptance: [MAIN_EXAMPLE],
    submission: { by: 'sq-exec-acceptance', at: '2026-10-27T10:00:00.000Z', commit: CANDIDATE, verify: 'npm test', integratedAt: null },
  }, extra);
}

function viewFor(ticket: any, evidence: { root: string; directory: string }) {
  return completionView(ticket, {
    demonstrations: readDemonstrations(evidence.directory),
    roots: { verification: evidence.root, evidence: evidence.directory, project: null },
  });
}

test('acceptance input keeps bounded main and boundary examples and refuses everything else', () => {
  assert.deepStrictEqual(acceptanceExamplesInput([MAIN_EXAMPLE, { ...BOUNDARY_EXAMPLE, scenario: `  ${BOUNDARY_EXAMPLE.scenario}  ` }]), [MAIN_EXAMPLE, BOUNDARY_EXAMPLE]);
  assert.deepStrictEqual(acceptanceExamplesInput([]), []);
  const tooMany = Array.from({ length: ACCEPTANCE_MAX_EXAMPLES + 1 }, (_, index) => ({ ...MAIN_EXAMPLE, scenario: `scenario ${index}` }));
  assert.throws(() => acceptanceExamplesInput(tooMany), /at most 8 examples/);
  assert.throws(() => acceptanceExamplesInput([{ ...MAIN_EXAMPLE, expected: 'x'.repeat(ACCEPTANCE_TEXT_MAX + 1) }]), /acceptance\[0\]\.expected must be plain text of 1 to 300 characters/);
  assert.throws(() => acceptanceExamplesInput([{ ...MAIN_EXAMPLE, scenario: '   ' }]), /acceptance\[0\]\.scenario must be plain text/);
  assert.throws(() => acceptanceExamplesInput([{ ...MAIN_EXAMPLE, scenario: 'bell\u0007' }]), /acceptance\[0\]\.scenario must be plain text/);
  assert.throws(() => acceptanceExamplesInput([{ ...MAIN_EXAMPLE, kind: 'edge' }]), /acceptance\[0\]\.kind must be main or boundary/);
  assert.throws(() => acceptanceExamplesInput([{ ...MAIN_EXAMPLE, observed: 'self-graded' }]), /acceptance\[0\] has unknown field observed/);
  assert.throws(() => acceptanceExamplesInput(['a string']), /acceptance\[0\] must be an object/);
  assert.throws(() => acceptanceExamplesInput([MAIN_EXAMPLE, MAIN_EXAMPLE]), /scenarios must be distinct/);
  assert.throws(() => acceptanceExamplesInput({ scenario: 'not a list' }), /acceptance must be an array/);
});

test('add and update carry acceptance; [] clears it and a claim holder cannot rewrite it', async () => {
  const { slug } = board('field');
  const added = await callTool('add', { project: slug, title: 'with acceptance', category: 'coding.easy', acceptance: [MAIN_EXAMPLE] });
  assert.deepStrictEqual(store.getTicket(slug, added.ref).acceptance, [MAIN_EXAMPLE]);
  await assert.rejects(callTool('add', { project: slug, title: 'bad acceptance', category: 'coding.easy', acceptance: [{ ...MAIN_EXAMPLE, kind: 'edge' }] }), /kind must be main or boundary/);

  const plain = await callTool('add', { project: slug, title: 'without acceptance', category: 'coding.easy' });
  assert.strictEqual(Object.hasOwn(store.getTicket(slug, plain.ref), 'acceptance'), false);

  await callTool('update', { project: slug, ref: added.ref, acceptance: [MAIN_EXAMPLE, BOUNDARY_EXAMPLE] });
  assert.deepStrictEqual(store.getTicket(slug, added.ref).acceptance, [MAIN_EXAMPLE, BOUNDARY_EXAMPLE]);
  await assert.rejects(callTool('update', { project: slug, ref: added.ref, acceptance: [{ ...MAIN_EXAMPLE, scenario: 'y'.repeat(301) }] }), /scenario must be plain text/);
  assert.deepStrictEqual(store.getTicket(slug, added.ref).acceptance, [MAIN_EXAMPLE, BOUNDARY_EXAMPLE], 'a refused update leaves the examples intact');

  const claimed = Object.assign(store.getTicket(slug, added.ref), { claim: { by: 'sq-exec-holder', at: new Date().toISOString() } });
  persist(slug, claimed);
  assert.throws(() => store.updateTicket(slug, claimed.ref, { acceptance: [MAIN_EXAMPLE], by: 'sq-exec-holder' }), /refusing active-claim update for acceptance/);
  store.updateTicket(slug, claimed.ref, { acceptance: [MAIN_EXAMPLE, BOUNDARY_EXAMPLE], by: 'sq-exec-holder' });
  persist(slug, Object.assign(store.getTicket(slug, claimed.ref), { claim: null }));

  await callTool('update', { project: slug, ref: added.ref, acceptance: [] });
  assert.strictEqual(Object.hasOwn(store.getTicket(slug, added.ref), 'acceptance'), false);
});

test('the dispatch briefing lists each example with the demonstration contract inside its byte budget', () => {
  const evidence = path.join(os.tmpdir(), 'sq-acceptance-briefing', 'SQ-9');
  const base = { ref: 'SQ-9', title: 'Briefing fixture', category: {}, dispatch: { evidenceDirectory: evidence } };
  const without = agentsync.renderTicketBriefing(base, 'acceptance-token');
  assert.ok(!without.includes('Acceptance examples:'), 'no examples, no packet');

  const briefing = agentsync.renderTicketBriefing({ ...base, acceptance: [MAIN_EXAMPLE, BOUNDARY_EXAMPLE] }, 'acceptance-token');
  assert.ok(briefing.includes(`Acceptance examples:\n1. [main] ${MAIN_EXAMPLE.scenario}\n   Expected: ${MAIN_EXAMPLE.expected}\n2. [boundary] ${BOUNDARY_EXAMPLE.scenario}`));
  assert.ok(briefing.includes(path.join(evidence, 'demonstrations.json')));
  assert.match(briefing, /\{ scenario, expected, observed, matches, environment, candidate, fixture, artifact, kind \}/);
  assert.match(briefing, /Screenshots prove appearance only, and a narrated tour is not execution proof\./);
  assert.match(briefing, /record it with matches false, then repair and demonstrate again or release with the record intact/);
  assert.match(briefing, /Never run destructive tests, send external messages, take financial actions or change access/);
  assert.ok(briefing.indexOf('Acceptance examples:') > briefing.indexOf('Description:'));

  const fullest = Array.from({ length: ACCEPTANCE_MAX_EXAMPLES }, (_, index) => ({ scenario: `${index}`.padEnd(ACCEPTANCE_TEXT_MAX, 's'), expected: 'e'.repeat(ACCEPTANCE_TEXT_MAX), kind: 'main' }));
  const fullBriefing = agentsync.renderTicketBriefing({ ...base, acceptance: fullest }, 'acceptance-token');
  const added = Buffer.byteLength(fullBriefing, 'utf8') - Buffer.byteLength(without, 'utf8');
  assert.ok(added <= ACCEPTANCE_MAX_EXAMPLES * (2 * ACCEPTANCE_TEXT_MAX + 30) + 1500, `the acceptance packet added ${added} bytes`);

  const undispatched = agentsync.renderTicketBriefing({ ref: 'SQ-9', title: 'No dispatch', category: {}, acceptance: [MAIN_EXAMPLE] }, 'acceptance-token');
  assert.match(undispatched, /demonstrations\.json in this ticket's board evidence directory/);
});

test('a complete current record reads as real-flow evidence with observed against expected', () => {
  const evidence = evidenceDirectory('complete');
  recordDemonstrations(evidence.directory, [demonstration()]);
  const view = viewFor(submittedTicket(), evidence);
  assert.deepStrictEqual(view.acceptance.map((result: any) => [result.status, result.evidence, result.observed]), [['demonstrated', 'real-flow', 'one brief row, description absent']]);
  const row = view.evidence.find((entry: any) => entry.kind === 'real-flow');
  assert.ok(row, 'a real-flow evidence row');
  assert.strictEqual(row.path, path.join(evidence.directory, 'main.log'));
  assert.match(row.label, /^demonstrated demonstration "list --brief on a board with one ticket": expected one brief row without a description; observed one brief row, description absent$/);
  assert.match(view.text, /Demonstrated 1 of 1 acceptance examples\./);
  assert.doesNotMatch(view.text, /Not demonstrated/);
});

test('a missing record leaves each example not demonstrated, and a partial one names its gaps', () => {
  const evidence = evidenceDirectory('missing');
  const missing = viewFor(submittedTicket({ acceptance: [MAIN_EXAMPLE, BOUNDARY_EXAMPLE] }), evidence);
  assert.deepStrictEqual(missing.acceptance.map((result: any) => [result.status, result.detail]), [['not demonstrated', 'no record'], ['not demonstrated', 'no record']]);
  assert.strictEqual(missing.evidence.some((entry: any) => ['real-flow', 'visual'].includes(entry.kind)), false);
  assert.match(missing.text, /Demonstrated 0 of 2 acceptance examples\./);
  assert.match(missing.text, /Still uncertain: .*Not demonstrated: list --brief on a board with one ticket \(no record\)\./);

  recordDemonstrations(evidence.directory, [demonstration({ observed: '', environment: '' })]);
  const partial = viewFor(submittedTicket(), evidence);
  assert.deepStrictEqual(partial.acceptance.map((result: any) => [result.status, result.detail, result.evidence]), [['not demonstrated', 'partial record, missing observed, environment', null]]);
  assert.strictEqual(partial.evidence.some((entry: any) => entry.kind === 'real-flow'), false);

  fs.writeFileSync(path.join(evidence.directory, 'demonstrations.json'), '{not json');
  assert.match(viewFor(submittedTicket(), evidence).acceptance[0].detail, /^demonstrations\.json is unreadable: /);
  fs.writeFileSync(path.join(evidence.directory, 'demonstrations.json'), JSON.stringify({ scenario: 'object, not array' }));
  assert.strictEqual(viewFor(submittedTicket(), evidence).acceptance[0].detail, 'demonstrations.json is not a JSON array');
});

test('a changed candidate after the record marks the demonstration stale', () => {
  const evidence = evidenceDirectory('stale');
  recordDemonstrations(evidence.directory, [demonstration()]);
  const ticket = submittedTicket({ submission: { ...submittedTicket().submission, commit: NEWER_CANDIDATE } });
  const view = viewFor(ticket, evidence);
  assert.strictEqual(view.acceptance[0].status, 'stale');
  assert.strictEqual(view.acceptance[0].detail, 'recorded for cccccccccccc, candidate is now dddddddddddd');
  assert.match(view.evidence.find((entry: any) => entry.kind === 'real-flow').label, /^stale demonstration/);
  assert.match(view.text, /Demonstration stale: list --brief/);
  assert.match(view.text, /Demonstrated 0 of 1/);
});

test('a screenshot entry reads as visual, never real-flow', () => {
  const evidence = evidenceDirectory('visual');
  recordDemonstrations(evidence.directory, [demonstration({ artifact: 'panel.png', kind: 'real-flow' })], ['panel.png']);
  const view = viewFor(submittedTicket(), evidence);
  assert.deepStrictEqual(view.acceptance.map((result: any) => [result.status, result.evidence]), [['demonstrated', 'visual']]);
  assert.deepStrictEqual(view.evidence.filter((entry: any) => ['real-flow', 'visual'].includes(entry.kind)).map((entry: any) => entry.kind), ['visual']);
  assert.match(view.text, /Demonstrated 1 of 1 acceptance examples \(1 by screenshot only\)\./);
});

test('an artifact outside the board evidence root, or absent from disk, is refused', () => {
  const evidence = evidenceDirectory('outside');
  const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-acceptance-elsewhere-')), 'proof.log');
  fs.writeFileSync(outside, 'planted\n');
  recordDemonstrations(evidence.directory, [demonstration({ artifact: outside })], []);
  const refused = viewFor(submittedTicket(), evidence);
  assert.deepStrictEqual(refused.acceptance.map((result: any) => [result.status, result.detail]), [['not demonstrated', 'artifact outside the board evidence directory']]);
  assert.strictEqual(refused.evidence.some((entry: any) => entry.path === outside), false);

  recordDemonstrations(evidence.directory, [demonstration({ artifact: '../../escape.log' })], []);
  assert.strictEqual(viewFor(submittedTicket(), evidence).acceptance[0].detail, 'artifact outside the board evidence directory');

  recordDemonstrations(evidence.directory, [demonstration({ artifact: 'never-written.log' })], []);
  assert.strictEqual(viewFor(submittedTicket(), evidence).acceptance[0].detail, 'artifact file not found');
});

test('a failed demonstration stays recorded and sends the orchestrator to review it', () => {
  const evidence = evidenceDirectory('failed');
  recordDemonstrations(evidence.directory, [demonstration({ observed: 'two rows, one duplicated', matches: false })]);
  const view = viewFor(submittedTicket(), evidence);
  assert.deepStrictEqual(view.acceptance.map((result: any) => [result.status, result.observed]), [['failed', 'two rows, one duplicated']]);
  assert.match(view.evidence.find((entry: any) => entry.kind === 'real-flow').label, /^failed demonstration .*observed two rows, one duplicated$/);
  assert.match(view.text, /Demonstration FAILED: list --brief/);
  assert.match(view.text, /Your action: Review the failed demonstration before accepting this candidate\./);
  assert.doesNotMatch(view.text, /No action needed/);
});

test('the completion read finds demonstrations.json in the dispatch evidence directory', async () => {
  const { slug } = board('read');
  const evidence = evidenceDirectory('read');
  const created = store.createTicket(slug, { title: 'read fixture', source: 'test', acceptance: [MAIN_EXAMPLE, BOUNDARY_EXAMPLE] });
  const ticket = Object.assign(store.getTicket(slug, created.id), submittedTicket({ ref: created.ref, acceptance: [MAIN_EXAMPLE, BOUNDARY_EXAMPLE] }), {
    dispatch: { evidenceDirectory: evidence.directory },
  });
  persist(slug, ticket);
  recordDemonstrations(evidence.directory, [demonstration()]);
  const view = await callTool('completion', { project: slug, ref: created.ref });
  assert.deepStrictEqual(view.acceptance.map((result: any) => result.status), ['demonstrated', 'not demonstrated']);
  assert.ok(view.evidence.some((entry: any) => entry.kind === 'real-flow' && entry.path === path.join(evidence.directory, 'main.log')));
});
