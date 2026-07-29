import './_temp-cleanup.js';
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

process.env.SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-category-band-test-'));
const DISCOVERY = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-category-band-catalog-'));
fs.mkdirSync(path.join(DISCOVERY, 'model-gateway'), { recursive: true });
fs.writeFileSync(path.join(DISCOVERY, 'model-gateway', 'catalog.json'), JSON.stringify({
  schemaVersion: 3,
  source: 'model-gateway',
  codexReadiness: { ready: true, state: 'ready', message: 'Codex readiness confirms the local gateway is ready.' },
  models: [
    { slug: 'codex-gpt-5-6-sol', id: 'claude-gpt-5.6-sol[1m]', label: 'GPT-5.6 Sol' },
    { slug: 'codex-gpt-5-6-terra', id: 'claude-gpt-5.6-terra[1m]', label: 'GPT-5.6 Terra' },
  ],
}));
process.env.SIDEQUEST_DISCOVERY_DIRS = DISCOVERY;
const store = require('../lib/store.js');

test('legacy complexity bands are fixed category mappings', () => {
  for (let complexity = 1; complexity <= 10; complexity++) {
    const expected = complexity <= 3 ? 'coding.easy' : complexity <= 6 ? 'coding.normal' : 'coding.hard';
    assert.equal(store.legacyCategoryForComplexity(complexity), expected);
  }
});

test('invalid legacy complexity has no routing category', () => {
  for (const value of [null, '', 0, 11, 'bad']) assert.equal(store.legacyCategoryForComplexity(value), null);
});

test('category filters select stable policy while model filters select resolved runtime', () => {
  const project = store.ensureProject(path.join(store.homeRoot(), 'project'));
  store.setCategory('coding.hard', { fallback: { model: 'opus', effort: 'high' } });
  store.createTicket(project.slug, { title: 'easy', category: 'coding.easy' });
  store.createTicket(project.slug, { title: 'hard', category: 'coding.hard' });
  assert.deepEqual(store.readyTickets(project.slug, { category: 'coding.easy' }).map((ticket?: any) => ticket.title), ['easy']);
  const easyModel = store.getTicket(project.slug, 'SQ-1').model;
  assert.deepEqual(store.readyTickets(project.slug, { model: easyModel }).map((ticket?: any) => ticket.title), ['easy']);
  assert.throws(() => store.readyTickets(project.slug, { model: 'missing-model' }), /Unknown model/);
});

export {};
