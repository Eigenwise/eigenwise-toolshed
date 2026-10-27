import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const { changesCatchupPayload, completionView } = require('../lib/store/completion.js') as typeof import('../src/lib/store/completion.js');
import type { CompletionContext, CompletionTicket } from '../src/lib/store/completion.js';
const store = require('../lib/store.js');
const database = require('../lib/db.js');
const mcp = require('../lib/mcp.js');
const { makeMcpCaller, makeCliRunner } = require('./_helpers.js');
const { callTool } = makeMcpCaller(mcp);
const SINCE = '2026-10-27T01:00:00.000Z';
const AFTER = '2026-10-27T02:00:00.000Z';

function board() {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-catchup-'));
  return { slug: store.ensureProject(projectPath).slug, projectPath };
}

function ticketWith(slug: string, fields: Record<string, unknown> = {}) {
  const created = store.createTicket(slug, { title: 'Catch-up fixture', source: 'test' });
  const ticket = { ...store.getTicket(slug, created.ref), updatedAt: AFTER, ...fields };
  database.putRow(database.openDb(process.env.SIDEQUEST_HOME), 'tickets', {
    id: ticket.id, project: slug, ref: ticket.ref, status: ticket.status,
    archived: 0, ord: ticket.order, claim_by: ticket.claim?.by ?? null, data: ticket,
  });
  return ticket;
}

function catchup(slug: string, since = SINCE) {
  return changesCatchupPayload(slug, store.changesPayload(slug, since), store);
}

test('catch-up stages and actions derive from real store records', () => {
  const { slug } = board();
  ticketWith(slug, { status: 'doing', claim: { by: 'sq-running' } });
  ticketWith(slug, { submission: { commit: 'a'.repeat(40), by: 'sq-submitted' } });
  ticketWith(slug, { rejectedSubmissions: [{ commit: 'b'.repeat(40), reason: 'review found X' }] });
  ticketWith(slug, { status: 'done', completion: { delivery: { commit: 'c'.repeat(40) } } });
  ticketWith(slug, { status: 'done' });
  ticketWith(slug);
  const result = catchup(slug);
  assert.deepEqual(result.tickets.map((ticket) => ticket.stage).sort(), ['running', 'submitted', 'rejected', 'integrated', 'closed', 'ready'].sort());
  assert.match(result.text, /Claimed by sq-running/);
  assert.match(result.text, /review found X/);
  assert.match(result.text, /integrated · Catch-up fixture · no action/);
  assert.equal(result.tickets.find((ticket) => ticket.stage === 'submitted')!.actor, 'orchestrator');
  assert.match(result.tickets.find((ticket) => ticket.stage === 'submitted')!.nextAction, /Integrate/);
});

test('dependency continuation is promised only when every dependency has a live claim', () => {
  const { slug } = board();
  const unscheduled = ticketWith(slug);
  const active = ticketWith(slug, { status: 'doing', claim: { by: 'sq-dependency' } });
  const waiting = ticketWith(slug);
  store.linkTickets(slug, waiting.ref, 'blocked-by', unscheduled.ref);
  store.linkTickets(slug, waiting.ref, 'blocked-by', active.ref);
  let row = catchup(slug).tickets.find((ticket) => ticket.ref === waiting.ref)!;
  assert.equal(row.stage, 'blocked');
  assert.equal(row.actor, 'dependency');
  assert.doesNotMatch(row.nextAction, /will continue/);
  store.unlinkTickets(slug, waiting.ref, unscheduled.ref);
  row = catchup(slug).tickets.find((ticket) => ticket.ref === waiting.ref)!;
  assert.equal(row.nextAction, 'The agent will continue when they finish.');
});

test('catch-up preserves exclusive since and serverTime and bounds rows', () => {
  const { slug } = board();
  ticketWith(slug, { updatedAt: SINCE });
  for (let index = 0; index < 42; index++) ticketWith(slug);
  const delta = store.changesPayload(slug, SINCE);
  const result = changesCatchupPayload(slug, delta, store);
  assert.equal(delta.tickets.length, 42);
  assert.equal(result.serverTime, delta.serverTime);
  assert.equal(result.since, SINCE);
  assert.equal(result.tickets.length, 40);
  assert.match(result.text, /\+2 more, narrow since$/);
  assert.equal(catchup(slug, AFTER).text, 'nothing changed since ' + AFTER);
});

test('integrating and released lines use completion authority and sanitize multiline text', () => {
  const ticket: CompletionTicket = { ref: 'SQ-1', title: '<tag>\nsecond line', submission: { commit: 'a'.repeat(40) } };
  const context: CompletionContext = { integrationProgress: { state: 'running' } };
  const view = completionView(ticket, context);
  const adapter = { getTicket: () => ticket, completionPayload: () => view };
  const delta = { since: SINCE, serverTime: AFTER, tickets: [{ ref: ticket.ref }] };
  assert.match(changesCatchupPayload('fixture', delta, adapter).text, /integrating/);
  ticket.status = 'done';
  ticket.completion = { delivery: { commit: 'a'.repeat(40) } };
  const released = completionView(ticket, { releaseRecord: { version: '1.0.0', deliveryCommit: 'a'.repeat(40) } });
  const result = changesCatchupPayload('fixture', delta, { ...adapter, completionPayload: () => released });
  assert.match(result.text, /released · &lt;tag&gt; second line · no action/);
  assert.equal(result.text.split('\n').length, 1);
});

test('MCP catch-up and CLI --catchup share lines while plain changes stays unchanged', async () => {
  const { slug, projectPath } = board();
  const ticket = ticketWith(slug, { status: 'doing', claim: { by: 'sq-transport' } });
  const result = await callTool('changes', { project: slug, since: SINCE, view: 'catchup' });
  assert.match(result.text, /running.*sq-transport/);
  assert.equal(result.tickets[0].ref, ticket.ref);
  const plain = await callTool('changes', { project: slug, since: SINCE });
  assert.equal(plain.text, undefined);
  assert.equal(plain.tickets[0].stage, undefined);
  const { runCli } = makeCliRunner(path.resolve(__dirname, '../bin/sidequest.js'));
  const cli = runCli(['changes', '--since', SINCE, '--project', projectPath, '--catchup']);
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout.trim(), result.text);
});
