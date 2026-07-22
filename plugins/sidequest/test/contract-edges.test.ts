'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-contract-edges-home-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;

const store = require('../lib/store.js');
const agentsync = require('../lib/agentsync.js');

function project(name: string) {
  return store.ensureProject(path.join(os.tmpdir(), 'sq-contract-edges-project-', name)).slug;
}

function ticket(slug: string, title: string, files: string[], contracts: Record<string, string[]> = {}, contractWaiver = false) {
  return store.createTicket(slug, {
    title,
    files,
    contracts,
    contractWaiver,
    complexity: 1,
    complexityWhy: 'A focused contract-edge fixture with an isolated verification case.',
  });
}

test('produce and consume contract edges sequence disjoint file scopes and name the reason', () => {
  const slug = project('produce-consume');
  const producer = ticket(slug, 'produce payload', ['src/producer.ts'], { produces: ['WidgetPayload'] });
  const consumer = ticket(slug, 'consume payload', ['src/consumer.ts'], { consumes: ['widgetpayload'] });
  store.updateTicket(slug, consumer.ref, { priority: 'urgent' });

  const payload = store.readyPayload(slug, { brief: true });
  assert.deepEqual(payload.waves, [[producer.ref], [consumer.ref]]);
  assert.deepEqual(payload.waveDependencies, [{
    before: producer.ref,
    after: consumer.ref,
    contract: 'WidgetPayload',
    type: 'produces-consumes',
    reason: `${producer.ref} produces WidgetPayload, which ${consumer.ref} consumes.`,
  }]);

  const briefing = agentsync.renderTicketBriefing(store.getTicket(slug, consumer.ref), 'nonce', slug);
  assert.match(briefing, /Contract metadata:\n- consumes: widgetpayload/);
  assert.match(briefing, new RegExp(`${producer.ref} produces WidgetPayload, which ${consumer.ref} consumes\\.`));
});

test('change collisions sequence disjoint file scopes and preserve the named contract', () => {
  const slug = project('changes');
  const first = ticket(slug, 'change interface one', ['src/one.ts'], { changes: ['BoardTicket'] });
  const second = ticket(slug, 'change interface two', ['src/two.ts'], { changes: ['boardticket'] });

  const payload = store.readyPayload(slug, { brief: true });
  assert.deepEqual(payload.waves, [[first.ref], [second.ref]]);
  assert.equal(payload.waveDependencies[0].type, 'changes-changes');
  assert.equal(payload.waveDependencies[0].contract, 'BoardTicket');
  assert.match(payload.waveDependencies[0].reason, /both change BoardTicket/);
});

test('an explicit reviewed waiver permits otherwise colliding contract edges', () => {
  const slug = project('waiver');
  const first = ticket(slug, 'waived change one', ['src/one.ts'], { changes: ['SharedContract'] }, true);
  const second = ticket(slug, 'waived change two', ['src/two.ts'], { changes: ['sharedcontract'] });

  const payload = store.readyPayload(slug, { brief: true });
  assert.deepEqual(payload.waves, [[first.ref, second.ref]]);
  assert.deepEqual(payload.waveDependencies, []);
  const brief = payload.tickets.find((entry: any) => entry.ref === first.ref);
  assert.equal(brief.contracts.waiver, true);
});

test('tickets without contract metadata stay file-scope-only', () => {
  const slug = project('absent');
  const first = ticket(slug, 'plain one', ['src/one.ts']);
  const second = ticket(slug, 'plain two', ['src/two.ts']);

  const payload = store.readyPayload(slug, { brief: true });
  assert.deepEqual(payload.waves, [[first.ref, second.ref]]);
  assert.deepEqual(payload.waveDependencies, []);
  assert.deepEqual(payload.tickets.find((entry: any) => entry.ref === first.ref).contracts, {
    produces: [],
    changes: [],
    consumes: [],
    waiver: false,
  });
});
